# toro-hub-api — Plan de implementación

> Base: `toro-hub-web/docs/ARCHITECTURE.md` (monolito modular hexagonal).
> Decisión nueva: **Hono sobre Cloudflare Workers (free tier)** en lugar de un proceso Node.
> El front **no se toca** en este plan; el backend expone el contrato que el front adoptará después.

---

## 0. Qué cambia al pasar de "servicio Node" a Workers free tier

El doc de arquitectura asume un proceso Node de larga vida. En Workers varias piezas cambian o desaparecen:

| Pieza del doc | En Workers free | Ajuste |
|---|---|---|
| Cache LRU en memoria por módulo | La memoria del isolate no es fiable ni compartida | **Cache API** (`caches.default`) + `fetch(..., { cf: { cacheTtl } })` hacia los proveedores. Sin LRU propio. |
| Bulkhead (`p-limit` por módulo) | Cada request corre aislada; no hay "proceso" que saturar | Se elimina. El recurso compartido real es la **cuota** (100k req/día) y **50 subrequests por request**. |
| Circuit breaker por adapter | Estado en memoria del isolate = best-effort | Se mantiene en memoria (módulo-scope), sin KV (KV free = 1k escrituras/día). Suficiente: el timeout es la protección principal. |
| Crash / fuga de memoria / event loop tumba todo | Una excepción mata **una request**, no el servicio | Riesgo del doc §3.1 "Límite conocido" desaparece casi por completo. `ENABLED_MODULES` se mantiene como salida de emergencia (mismo código, varios Workers). |
| Réplicas + `unhandledRejection` | Lo hace la plataforma | Se elimina. |
| Proxy de descargas en streaming | `return new Response(upstream.body)` no consume CPU mientras espera I/O | Funciona igual, sin cargar en memoria. |
| Secrets en `.env` | `wrangler secret put` / `.dev.vars` en local | — |

Límites del free tier a respetar en el diseño:

- **10 ms de CPU por request** (el tiempo esperando a TMDB no cuenta). → No validar respuestas con zod en runtime, solo entradas. Mapear con funciones planas.
- **50 subrequests por request.** → Usar `append_to_response` de TMDB; el scatter-gather de streams no puede pasar de ~10 proveedores.
- **100k requests/día.** → Cache agresivo en el borde (`Cache-Control` + Cache API) para que las repetidas no lleguen al Worker.
- **Cache API no funciona en `*.workers.dev`**, solo en un dominio propio. → Desplegar en `api.toro-hub.x` desde la fase 1.

---

## 1. Estructura

```
toro-hub-api/
├─ src/
│  ├─ index.ts                 OpenAPIHono raíz: monta módulos según ENABLED_MODULES, /openapi.json, /health
│  ├─ env.ts                   tipo Bindings (TMDB_API_KEY, SITE_PASSWORD, JWT_SECRET, ENABLED_MODULES…)
│  ├─ shared/                  SOLO infraestructura
│  │  ├─ http.ts               fetchJson(url, { timeoutMs, cacheTtl }) con AbortSignal.timeout
│  │  ├─ breaker.ts            circuit breaker en memoria (por adapter id)
│  │  ├─ errors.ts             AppError(code, status, module) + onError por módulo
│  │  ├─ cache.ts              middleware Cache API + Cache-Control por ruta
│  │  ├─ page.ts               schema zod Page<T> = { items, page, totalPages, totalResults }
│  │  └─ session.ts            verificación del JWT (middleware) — usa hono/jwt
│  └─ modules/
│     ├─ auth/                 routes.ts
│     ├─ flix/                 domain/  ports.ts  providers/metadata/tmdb.ts  providers/streams/*  registry.ts  services/  routes.ts  schemas.ts
│     ├─ miru/                 misma plantilla
│     └─ tome/                 misma plantilla (ContentProvider)
├─ test/                       vitest + @cloudflare/vitest-pool-workers
└─ wrangler.jsonc
```

Reglas:

- `modules/<a>` nunca importa de `modules/<b>`; solo de `shared/`. Se verifica con `dependency-cruiser` en CI.
- Cada módulo es un `OpenAPIHono` con su propio `onError` → errores con código propio (`FLIX_UPSTREAM_TIMEOUT`, `MIRU_SOURCE_UNAVAILABLE`…).
- Dependencias: las que ya están (`hono`, `@hono/zod-openapi`, `zod`). Añadir solo `vitest` + `@cloudflare/vitest-pool-workers` (dev) y `dependency-cruiser` (dev). JWT con `hono/jwt` (incluido en Hono).

---

## 2. Contrato común para el front futuro

Todo lo que el front consumirá comparte estas formas, para que el `apiClient` base sea uno solo:

```ts
// Paginación
Page<T> = { items: T[]; page: number; totalPages: number; totalResults: number }

// Error (cualquier 4xx/5xx)
{ error: { code: 'FLIX_UPSTREAM_TIMEOUT'; message: string; module: 'flix' } }

// Imágenes: el front nunca arma rutas. Tres tamaños fijos por tipo.
Image = { sm: string; md: string; lg: string } | null
//   poster:   sm=w154  md=w342  lg=w780
//   backdrop: sm=w780  md=w1280 lg=original
//   profile:  sm=w185  md=h632  lg=original
```

> El front hoy usa 9 tamaños distintos (w92…original). Tres por tipo cubren todos los usos con el más cercano por encima.

**IDs:** TMDB repite ids entre películas y series, así que el id canónico lleva el tipo: `tmdb-movie-603`, `tmdb-tv-1399`. Mismo patrón en Miru (`anilist-113415`) y Tome (`gutenberg-1342`). Sin `:` para que sea limpio en URLs del front (`/movie/[id]`).

**Géneros:** slugs propios (`crime`, `sci-fi`…). El mapa slug ↔ id de TMDB vive en `flix/providers/metadata/tmdb.ts`. Reemplaza `GENRE_IDS` del front.

---

## 3. Endpoints de Flix (derivados del uso real del front)

Inventario de `src/services/tmdb.ts` en el front (27 archivos lo importan). Funciones sin uso (`searchMovies`, `searchTV`, `getMovieGenres`, `getTVGenres`) no se migran.

| Endpoint | Reemplaza en el front | Cache |
|---|---|---|
| `GET /flix/lists/:kind?type=movie\|tv&page&region` — `kind`: `trending`, `popular`, `top-rated`, `upcoming`, `now-playing`, `airing-today`, `on-the-air` | `getTrending`, `getPopular*`, `getTopRated*`, `getUpcoming*`, `getNowPlaying*`, `getAiringTodayTV`, `getOnTheAirTV`, `get*ByRegion` | 1 h |
| `GET /flix/discover?type&genres&keywords&sort&releasedFrom&releasedTo&minRating&minVotes&lang&minRuntime&page` | `discoverMovies` (11 usos), `discoverTV` (7 usos) | 1 h |
| `GET /flix/search?q&page` | `searchMulti` | 10 min |
| `GET /flix/titles/:id` → detalle + credits + videos + recomendaciones (un solo fetch con `append_to_response`) | `getMovieDetail`, `getTVDetail`, `get*Credits`, `get*Videos`, `get*Recommendations`, `getSimilar*` | 24 h |
| `GET /flix/titles/:id/reviews?page` | `getMovieReviews`, `getTVReviews` (sección lazy) | 24 h |
| `GET /flix/titles/:id/seasons/:n` | `getTVSeason` | 24 h |
| `GET /flix/collections/:id` | `getCollection` | 24 h |
| `GET /flix/people/:id` → persona + créditos combinados | `getPersonDetail`, `getPersonCombinedCredits` | 24 h |
| `GET /flix/genres` → `{ slug, name, types }[]` | `GENRE_IDS` / `GENRE_NAMES` del front | 7 d |
| `GET /flix/playback/:id?s&e` → `Source[]` | `getMoviePlayerUrl`, `getTVPlayerUrl` | 1 h |
| `GET /flix/health` | — | no |

`Source = { provider: string; url: string; kind: 'embed' | 'hls'; quality?: string }`. Primer adapter: 111movies (hoy en `NEXT_PUBLIC_PLAYER_BASE_URL`), que solo construye la URL (sin subrequest).

`discover` traduce params propios → TMDB (`genre=crime` → `with_genres=80`, `sort=popular` → `popularity.desc`, `yearFrom` → `primary_release_date.gte` o `first_air_date.gte` según `type`). Así el front deja de conocer los params de TMDB.

---

## 4. Fases

Cada fase se despliega sola y deja `/openapi.json` al día.

### Fase 0 — Esqueleto (½ día) ✅ hecha
> Notas: `@cloudflare/vitest-pool-workers` se renombró a `@cloudflare/vitest-plugin` (es el que se usa). `cf-typegen` no se usa: los bindings están tipados a mano en `src/env.ts`. El dominio propio queda comentado en `wrangler.jsonc` hasta tenerlo.

- `wrangler.jsonc`: `observability.enabled: true`, ruta custom domain `api.toro-hub.x`, `vars.ENABLED_MODULES = "auth,flix"`.
- `src/index.ts` con `OpenAPIHono`, `app.doc('/openapi.json')`, `/health`, `onError` global con la forma de error común, `logger()` de Hono.
- `shared/http.ts` (timeout por `AbortSignal.timeout`), `shared/errors.ts`, `shared/page.ts`.
- `pnpm cf-typegen` para `CloudflareBindings`. `.dev.vars.example` con las claves.
- vitest con `@cloudflare/vitest-pool-workers` + un test de `/health`.
- **Listo cuando:** `pnpm dev` sirve `/health` y `/openapi.json`; deploy funciona en el dominio propio.

### Fase 1 — Flix catálogo (2–3 días) ✅ hecha
> Notas: sin `services/catalog.ts` todavía (las rutas llaman al provider del registry; se crea cuando haya fallback/enriquecedor). `discover` acepta `keywords` (slugs copiados de `genreSubcategories.ts` del front) y fechas exactas (`releasedFrom/To`) porque el calendario las usa. Géneros con id distinto en TV (action→10759, sci-fi→10765…) ya se traducen; un género sin equivalente en TV devuelve página vacía. Falta probar contra TMDB real (no hay key local).
- `flix/domain`: `Title`, `TitleDetail`, `Season`, `Episode`, `Person`, `Collection`, `Review`, `Video`, `Genre`.
- `flix/ports.ts`: `MetadataProvider` (como el doc).
- `providers/metadata/tmdb.ts`: adapter + mapeo TMDB → canónico + mapa de géneros. API key por header `Authorization: Bearer` (token v4) o query `api_key`, desde secret.
- `services/catalog.ts`: primario (TMDB) sin fallback todavía; el hueco queda en `registry.ts`.
- `routes.ts` con todas las rutas de la tabla §3 (salvo playback), schemas zod de entrada y salida para OpenAPI.
- `shared/cache.ts`: `Cache-Control: public, s-maxage=…` por ruta + Cache API.
- Tests: mapeo TMDB → canónico con fixtures JSON reales (uno por endpoint), y traducción de `discover`.
- **Listo cuando:** cada función usada por el front tiene endpoint equivalente y tipos en `/openapi.json`.

### Fase 2 — Auth / SSO (1 día) ✅ hecha
> Notas: `GET /auth/session` devuelve `{ authenticated, required, exp }` (`required: false` si no hay contraseña). Dominio de la cookie por la var `COOKIE_DOMAIN` (vacía en local; en local, sobre http, tampoco lleva `Secure`). La sesión se verifica en `index.ts` antes de montar cada módulo, así corre antes que su cache. Cambiar la contraseña NO invalida sesiones abiertas: para eso hay que rotar `JWT_SECRET`. Rate limiting del login sigue pendiente (retraso fijo de 500 ms, marcado como `shortcut:`).
- `POST /auth/login { password }` → compara con `SITE_PASSWORD` (comparación en tiempo constante), emite JWT HS256 (`hono/jwt`, `exp` 30 d) en cookie `th_session` (`HttpOnly; Secure; SameSite=Lax; Domain=.toro-hub.x`).
- `POST /auth/logout` → borra la cookie. `GET /auth/session` → `{ authenticated, exp }`.
- `shared/session.ts`: middleware que exige la cookie en `/flix`, `/miru`, `/tome` (si `SITE_PASSWORD` no está configurado, abierto, igual que hoy).
- El `proxy.ts` del front validará el mismo JWT con `JWT_SECRET` compartido (WebCrypto, sin dependencias).
- Anti fuerza bruta: retraso fijo de 500 ms en fallo (como hoy). Rate limiting real queda pendiente (ver §6).
- **Listo cuando:** login/logout/session funcionan y las rutas de verticales devuelven 401 sin cookie.

### Fase 3 — Flix playback + resiliencia (1 día) ✅ hecha
> Notas: `/flix/playback/:id` devuelve `{ sources, failed }` (no un array suelto) para que el front sepa qué proveedor falló. Sin cache de borde en playback: `private, max-age=600` si todo respondió, `no-store` si alguno falló. Breaker: abre tras 3 caídas (5xx/timeout; los 404 no cuentan), 30 s de cooldown, estado por isolate. Aplicado a TMDB y a cada stream provider. Base del embed configurable con la var `PLAYER_BASE_URL`.
- `flix/ports.ts`: `StreamProvider`. `providers/streams/111movies.ts`.
- `services/playback.ts`: scatter-gather con `Promise.allSettled` + timeout por provider; orden por prioridad del registry.
- `shared/breaker.ts` aplicado a cada adapter (metadata y streams).
- `/flix/health`: estado del breaker de cada adapter.
- **Listo cuando:** `/flix/playback/tmdb-movie-603` devuelve `Source[]` y un provider caído no rompe la respuesta.

### Fase 4 — Miru (3–5 días, con spike primero)
- **Spike (½ día) antes de todo:** confirmar que `anime-sdk` / `AnimeParadiseProvider` corre en Workers (`nodejs_compat`) y que el proveedor no bloquea IPs de Cloudflare. Si falla, el adapter se escribe con `fetch` directo o Miru se despliega como Worker aparte con `ENABLED_MODULES=miru`.
- Catálogo: AniList GraphQL (primario) + Jikan (enriquecedor por `idMal`; respetar su rate limit de ~3 req/s → solo en detalle, nunca en listas).
- Rutas: `GET /miru/lists/:kind` (trending, seasonal, top), `/miru/search`, `/miru/titles/:id`, `/miru/titles/:id/episodes`, `/miru/playback/:episodeId?lang=sub|dub`, `/miru/health`.
- Resolución obra → playback: buscar en AnimeParadise por título (romaji/english) y validar año + formato + nº de episodios. Guardar el match en Cache API (24 h) para no repetirlo.
- **Listo cuando:** de un id de AniList se llega a un `AnimeSource[]` reproducible.

### Fase 5 — Tome descargas (2–3 días)
- Primero verificar (pendiente del doc §7) qué fuentes permiten descarga directa: Gutendex, Standard Ebooks, Internet Archive.
- Catálogo: Open Library o Gutendex. `ContentProvider` como en el doc.
- Rutas: `/tome/search`, `/tome/books/:id`, `/tome/books/:id/files` (scatter-gather), `/tome/health`.
- `/tome/download/:id/:format` **solo si** algún proveedor lo necesita: stream directo del body con `Content-Disposition: attachment`, con allowlist de hosts (si no, es un open proxy).
- **Listo cuando:** un libro devuelve `BookFile[]` con enlaces que descargan.

### Fase 6 — Tome visor (futuro)
- Sin cambios de port: la ruta proxy añade `Access-Control-Allow-Origin` para los orígenes del front.

### Transversal (desde la fase 1)
- CI (GitHub Actions): `tsc --noEmit`, `vitest`, `depcruise`, y `wrangler deploy --dry-run`.
- Publicar `/openapi.json` en cada deploy; el front lo consumirá con `openapi-typescript` cuando migre.

---

## 5. Lo que hará el front cuando migre (referencia, no en este plan)

1. `next.config.ts`: rewrite `/api/:path*` → `https://api.toro-hub.x/:path*` (dev: `http://localhost:8787`).
2. `pnpm gen:api` con `openapi-typescript` → `src/api-types/`.
3. `services/tmdb.ts` → `verticals/flix/api.ts` contra los endpoints canónicos; `types/tmdb.ts` y los helpers de imagen desaparecen.
4. `app/api/login` y `app/api/logout` se borran; `middleware.ts` → `proxy.ts` validando el JWT.
5. `GENRE_IDS` y los params de discover pasan a slugs (`genre=crime`).

---

## 6. Riesgos y decisiones abiertas

- **anime-sdk en Workers:** riesgo principal; por eso el spike va primero en la fase 4.
- **Proveedores de streams bloqueando IPs de Cloudflare:** posible en Miru (scraping). Mitigación: el adapter devuelve `[]` y el breaker se abre; no rompe el resto.
- **Rate limiting del login:** el free tier no da contador compartido barato (KV: 1k escrituras/día). Opciones: Durable Object (disponible en free) o la regla de rate limiting del dominio en Cloudflare. Decidir en la fase 2.
- **Cuota 100k req/día:** con cache en el borde debería sobrar para uso personal; vigilar en el dashboard.
- **Front y API en dominios distintos en local:** `flix.localhost:3000` + rewrite a `localhost:8787` → la cookie con `Domain=.toro-hub.x` no aplica en local; en dev se emite sin `Domain`.
- **Hosting del front:** si va en Vercel, el rewrite `/api/*` hace que el Worker vea IPs de Vercel; no afecta al cache. Alternativa: el front también en Cloudflare (Workers + OpenNext) — fuera de este plan.
