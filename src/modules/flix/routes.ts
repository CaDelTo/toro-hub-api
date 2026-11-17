import { createRoute, z } from '@hono/zod-openapi';
import { breakerState } from '../../shared/breaker';
import { cacheFor } from '../../shared/cache';
import { errorResponses } from '../../shared/errors';
import { createModule } from '../../shared/module';
import { Collection, DiscoverQuery, Genre, ListKind, Person, Playback, ReviewPage, Season, TitleDetail, TitleId, TitlePage } from './domain';
import { METADATA_ID, metadataProvider, streamProviders } from './registry';
import { getPlayback } from './services/playback';

const HOUR = 3600;
const DAY = 24 * HOUR;

const ok = <T extends z.ZodType>(schema: T) => ({
  200: { description: 'OK', content: { 'application/json': { schema } } },
  ...errorResponses,
});

const Page = z.coerce.number().int().min(1).max(500).default(1);
const Id = z.object({ id: TitleId });

const flix = createModule('flix');

flix.use('/lists/*', cacheFor('flix', HOUR));
flix.use('/discover', cacheFor('flix', HOUR));
flix.use('/search', cacheFor('flix', 10 * 60));
flix.use('/titles/*', cacheFor('flix', DAY));
flix.use('/collections/*', cacheFor('flix', DAY));
flix.use('/people/*', cacheFor('flix', DAY));
flix.use('/genres', cacheFor('flix', 7 * DAY));

flix.openapi(
  createRoute({
    method: 'get',
    path: '/lists/{kind}',
    tags: ['flix'],
    summary: 'Listas editoriales (trending, popular, top-rated…)',
    description: '`upcoming` y `now-playing` solo existen para películas; `airing-today` y `on-the-air` solo para series; `type=all` solo para `trending`.',
    request: {
      params: z.object({ kind: ListKind }),
      query: z.object({
        type: z.enum(['movie', 'tv', 'all']).default('movie'),
        page: Page,
        region: z.string().length(2).optional().openapi({ description: 'ISO 3166-1 (solo popular)', example: 'CO' }),
        window: z.enum(['day', 'week']).default('week').openapi({ description: 'Solo trending' }),
      }),
    },
    responses: ok(TitlePage),
  }),
  async (c) => {
    const { kind } = c.req.valid('param');
    return c.json(await metadataProvider(c.env).list(kind, c.req.valid('query')), 200);
  },
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/discover',
    tags: ['flix'],
    summary: 'Explorar con filtros (género, fechas, nota, idioma…)',
    request: { query: DiscoverQuery },
    responses: ok(TitlePage),
  }),
  async (c) => c.json(await metadataProvider(c.env).discover(c.req.valid('query')), 200),
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/search',
    tags: ['flix'],
    summary: 'Buscar películas y series',
    request: { query: z.object({ q: z.string().trim().min(1).max(200), page: Page }) },
    responses: ok(TitlePage),
  }),
  async (c) => {
    const { q, page } = c.req.valid('query');
    return c.json(await metadataProvider(c.env).search(q, page), 200);
  },
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/titles/{id}',
    tags: ['flix'],
    summary: 'Detalle con reparto, videos y recomendaciones',
    request: { params: Id },
    responses: ok(TitleDetail),
  }),
  async (c) => c.json(await metadataProvider(c.env).getTitle(c.req.valid('param').id), 200),
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/titles/{id}/reviews',
    tags: ['flix'],
    summary: 'Reseñas',
    request: { params: Id, query: z.object({ page: Page }) },
    responses: ok(ReviewPage),
  }),
  async (c) => c.json(await metadataProvider(c.env).getReviews(c.req.valid('param').id, c.req.valid('query').page), 200),
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/titles/{id}/seasons/{season}',
    tags: ['flix'],
    summary: 'Temporada con episodios (solo series)',
    request: { params: Id.extend({ season: z.coerce.number().int().min(0) }) },
    responses: ok(Season),
  }),
  async (c) => {
    const { id, season } = c.req.valid('param');
    return c.json(await metadataProvider(c.env).getSeason(id, season), 200);
  },
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/collections/{id}',
    tags: ['flix'],
    summary: 'Saga / colección',
    request: { params: z.object({ id: z.string().openapi({ example: 'tmdb-collection-2344' }) }) },
    responses: ok(Collection),
  }),
  async (c) => c.json(await metadataProvider(c.env).getCollection(c.req.valid('param').id), 200),
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/people/{id}',
    tags: ['flix'],
    summary: 'Persona con su filmografía',
    request: { params: z.object({ id: z.string().openapi({ example: 'tmdb-person-6384' }) }) },
    responses: ok(Person),
  }),
  async (c) => c.json(await metadataProvider(c.env).getPerson(c.req.valid('param').id), 200),
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/genres',
    tags: ['flix'],
    summary: 'Géneros (slugs usados en `genres` de títulos y en /discover)',
    responses: ok(z.array(Genre)),
  }),
  (c) => c.json(metadataProvider(c.env).genres(), 200),
);

flix.openapi(
  createRoute({
    method: 'get',
    path: '/playback/{id}',
    tags: ['flix'],
    summary: 'Fuentes de reproducción de todos los proveedores',
    description: 'En series, `s` y `e` son obligatorios. Si un proveedor falla aparece en `failed` y el resto sigue respondiendo.',
    request: {
      params: Id,
      query: z
        .object({ s: z.coerce.number().int().min(0).optional(), e: z.coerce.number().int().min(1).optional() })
        .refine((q) => (q.s === undefined) === (q.e === undefined), { message: 's and e go together' }),
    },
    responses: ok(Playback),
  }),
  async (c) => {
    const { id } = c.req.valid('param');
    const { s, e } = c.req.valid('query');
    const result = await getPlayback(id, s === undefined ? undefined : { season: s, episode: e! }, streamProviders(c.env), async () =>
      (await metadataProvider(c.env).getTitle(id)).externalIds.imdb,
    );
    // Sin cache de borde: si un proveedor falló, no queremos fijar la respuesta incompleta.
    c.header('Cache-Control', result.failed.length ? 'no-store' : 'private, max-age=600');
    return c.json(result, 200);
  },
);

const ProviderHealth = z.object({ id: z.string(), kind: z.enum(['metadata', 'stream']), state: z.enum(['closed', 'open']) });

flix.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['flix'],
    summary: 'Salud del módulo y estado del circuit breaker de cada proveedor',
    description: 'El estado del breaker es por isolate de Workers: orientativo, no global.',
    responses: ok(z.object({ status: z.enum(['ok', 'degraded']), providers: z.array(ProviderHealth) })),
  }),
  (c) => {
    const providers = [
      { id: METADATA_ID, kind: 'metadata' as const, state: breakerState(`flix:metadata:${METADATA_ID}`) },
      ...streamProviders(c.env).map((p) => ({ id: p.id, kind: 'stream' as const, state: breakerState(`flix:stream:${p.id}`) })),
    ];
    c.header('Cache-Control', 'no-store');
    return c.json({ status: providers.some((p) => p.state === 'open') ? ('degraded' as const) : ('ok' as const), providers }, 200);
  },
);

export default flix;
