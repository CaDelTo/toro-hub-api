import { createRoute, z } from '@hono/zod-openapi';
import { breakerState } from '../../shared/breaker';
import { cacheFor } from '../../shared/cache';
import { AppError, errorResponses } from '../../shared/errors';
import { createModule } from '../../shared/module';
import { AnimeDetail, AnimeId, AnimePage, BrowseFilters, Character, Episode, ListKind, Playback, ScheduleEntry, Staff } from './domain';
import type { AnimeRef } from './ports';
import { enricher, METADATA_ID, metadataProvider, playbackProviders } from './registry';
import { getEpisodes, getPlayback } from './services/playback';

const HOUR = 3600;
const DAY = 24 * HOUR;

const ok = <T extends z.ZodType>(schema: T) => ({
  200: { description: 'OK', content: { 'application/json': { schema } } },
  ...errorResponses,
});

const Page = z.coerce.number().int().min(1).max(500).default(1);
const Id = z.object({ id: AnimeId });

/** Los proveedores de vídeo buscan por título; los ids de Kitsu/AniList confirman la obra exacta. */
async function animeRef(id: string): Promise<AnimeRef> {
  const a = await metadataProvider().getAnime(id);
  const { romaji, english } = a.alternativeTitles;
  return {
    ...a.externalIds,
    year: a.startDate ? Number(a.startDate.slice(0, 4)) : a.year,
    titles: [...new Set([romaji, english].filter((t): t is string => Boolean(t)))],
  };
}

/** Id de MyAnimeList, que Jikan necesita (de los mapeos de Kitsu). */
async function malId(id: string): Promise<number> {
  const { mal } = (await metadataProvider().getAnime(id)).externalIds;
  if (mal === null) throw new AppError('miru', 'NOT_FOUND', 404, 'No MyAnimeList id for this anime');
  return mal;
}

const miru = createModule('miru');

miru.use('/lists/*', cacheFor('miru', HOUR));
miru.use('/search', cacheFor('miru', 10 * 60));
miru.use('/browse', cacheFor('miru', HOUR));
miru.use('/schedule', cacheFor('miru', 6 * HOUR));
miru.use('/anime/:id', cacheFor('miru', DAY));
miru.use('/anime/:id/episodes', cacheFor('miru', HOUR)); // series en emisión suman episodios
miru.use('/anime/:id/characters', cacheFor('miru', DAY));
miru.use('/anime/:id/staff', cacheFor('miru', DAY));

miru.openapi(
  createRoute({
    method: 'get',
    path: '/lists/{kind}',
    tags: ['miru'],
    summary: 'Listas editoriales (trending, popular, top-rated, airing, upcoming)',
    request: { params: z.object({ kind: ListKind }), query: z.object({ page: Page }) },
    responses: ok(AnimePage),
  }),
  async (c) => c.json(await metadataProvider().list(c.req.valid('param').kind, c.req.valid('query').page), 200),
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/browse',
    tags: ['miru'],
    summary: 'Catálogo filtrado por temporada, año, formato, estado y género (Season y Explore)',
    request: { query: BrowseFilters.extend({ page: Page }) },
    responses: ok(AnimePage),
  }),
  async (c) => {
    const { page, ...filters } = c.req.valid('query');
    return c.json(await metadataProvider().browse(filters, page), 200);
  },
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/schedule',
    tags: ['miru'],
    summary: 'Emisiones de la semana (Calendar): día y hora en JST',
    description: 'Horario de MyAnimeList (Jikan) con ids de Kitsu. Las series sin mapeo a Kitsu no salen: no tendrían página.',
    responses: ok(z.array(ScheduleEntry)),
  }),
  async (c) => {
    const slots = await enricher().getSchedule();
    const ids = await metadataProvider().idsFromMal(slots.map((s) => s.mal));
    return c.json(
      slots.flatMap(({ mal, ...s }) => {
        const id = ids.get(mal);
        return id ? [{ id, ...s }] : [];
      }),
      200,
    );
  },
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/search',
    tags: ['miru'],
    summary: 'Buscar anime',
    request: { query: z.object({ q: z.string().trim().min(1).max(200), page: Page }) },
    responses: ok(AnimePage),
  }),
  async (c) => {
    const { q, page } = c.req.valid('query');
    return c.json(await metadataProvider().search(q, page), 200);
  },
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/anime/{id}',
    tags: ['miru'],
    summary: 'Detalle de un anime',
    request: { params: Id },
    responses: ok(AnimeDetail),
  }),
  async (c) => c.json(await metadataProvider().getAnime(c.req.valid('param').id), 200),
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/anime/{id}/episodes',
    tags: ['miru'],
    summary: 'Episodios disponibles para reproducir',
    description: 'Vienen del proveedor de vídeo, no del catálogo: son los que de verdad se pueden ver.',
    request: { params: Id },
    responses: ok(z.array(Episode)),
  }),
  async (c) => c.json(await getEpisodes(await animeRef(c.req.valid('param').id), playbackProviders(), enricher()), 200),
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/anime/{id}/characters',
    tags: ['miru'],
    summary: 'Personajes con sus actores de voz (MyAnimeList vía Jikan)',
    request: { params: Id },
    responses: ok(z.array(Character)),
  }),
  async (c) => c.json(await enricher().getCharacters(await malId(c.req.valid('param').id)), 200),
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/anime/{id}/staff',
    tags: ['miru'],
    summary: 'Staff (MyAnimeList vía Jikan)',
    request: { params: Id },
    responses: ok(z.array(Staff)),
  }),
  async (c) => c.json(await enricher().getStaff(await malId(c.req.valid('param').id)), 200),
);

miru.openapi(
  createRoute({
    method: 'get',
    path: '/playback/{id}',
    tags: ['miru'],
    summary: 'Fuentes HLS (con subtítulos) de un episodio',
    description: 'Si un proveedor falla aparece en `failed` y el resto sigue respondiendo. Los enlaces caducan pronto: pedirlos al darle a reproducir.',
    request: { params: Id, query: z.object({ ep: z.coerce.number().min(0) }) },
    responses: ok(Playback),
  }),
  async (c) => {
    const result = await getPlayback(await animeRef(c.req.valid('param').id), c.req.valid('query').ep, playbackProviders());
    c.header('Cache-Control', 'no-store'); // enlaces firmados de vida corta
    return c.json(result, 200);
  },
);

const ProviderHealth = z.object({ id: z.string(), kind: z.enum(['metadata', 'playback']), state: z.enum(['closed', 'open']) });

miru.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['miru'],
    summary: 'Salud del módulo y estado del circuit breaker de cada proveedor',
    description: 'El estado del breaker es por isolate de Workers: orientativo, no global.',
    responses: ok(z.object({ status: z.enum(['ok', 'degraded']), providers: z.array(ProviderHealth) })),
  }),
  (c) => {
    const providers = [
      ...[METADATA_ID, enricher().id].map((id) => ({ id, kind: 'metadata' as const, state: breakerState(`miru:metadata:${id}`) })),
      ...playbackProviders().map((p) => ({ id: p.id, kind: 'playback' as const, state: breakerState(`miru:playback:${p.id}`) })),
    ];
    c.header('Cache-Control', 'no-store');
    return c.json({ status: providers.some((p) => p.state === 'open') ? ('degraded' as const) : ('ok' as const), providers }, 200);
  },
);

export default miru;
