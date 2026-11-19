import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from 'anime-sdk';
import app from '../src/index';
import type { AnimePlaybackProvider } from '../src/modules/miru/ports';
import { createAnimeParadise } from '../src/modules/miru/providers/playback/animeparadise';
import { getPlayback } from '../src/modules/miru/services/playback';

// Fixtures recortados de respuestas reales de Kitsu y AnimeParadise.
const anime = {
  id: '46474', type: 'anime',
  attributes: {
    canonicalTitle: 'Sousou no Frieren',
    titles: { en: 'Frieren: Beyond Journey’s End', en_jp: 'Sousou no Frieren', ja_jp: '葬送のフリーレン' },
    synopsis: 'After the party of heroes defeated the Demon King…\n', subtype: 'TV', status: 'finished',
    startDate: '2023-09-29', endDate: '2024-03-22', episodeCount: 28, episodeLength: 24, averageRating: '88.87',
    posterImage: { small: 'https://img.test/s.jpg', medium: 'https://img.test/m.jpg', large: 'https://img.test/l.jpg' },
    coverImage: { large: 'https://img.test/cover.jpg' },
  },
  relationships: { categories: { data: [{ type: 'categories', id: '157' }, { type: 'categories', id: '184' }] } },
};
const categories = [
  { type: 'categories', id: '157', attributes: { title: 'Adventure' } },
  { type: 'categories', id: '184', attributes: { title: 'Drama' } },
  { type: 'categories', id: '999', attributes: { title: 'De otro anime' } },
];
const mappings = [
  { type: 'mappings', id: '1', attributes: { externalSite: 'myanimelist/anime', externalId: '52991' } },
  { type: 'mappings', id: '2', attributes: { externalSite: 'anilist/anime', externalId: '154587' } },
];
const kitsuImg = (id: number) => `https://media.kitsu.app/anime/${id}/cover_image/large-abc.jpeg`;
// La temporada 2 aparece primero en la búsqueda: el mapeo debe elegir por id, no por orden.
const apSearch = {
  data: [
    { _id: 'S2', title: 'Sousou no Frieren 2', coverImage: { large: kitsuImg(49240) } },
    { _id: 'S1', title: 'Sousou no Frieren', coverImage: { large: kitsuImg(46474) } },
  ],
};
const apEpisodes = { data: [{ uid: 'u1', number: '1', title: 'The Journey’s End' }, { uid: 'u2', number: '2', title: 'It Didn’t Have to Be Magic' }] };
const apEp = { data: { episode: { streamLink: 'TOKEN', subData: [{ src: 'https://stream.test/captions?url=x', label: 'Spanish', type: 'vtt' }] } } };

const jikanImg = (url: string) => ({ jpg: { image_url: url } });
const jikanCharacters = {
  data: [{
    character: { name: 'Frieren', images: jikanImg('https://cdn.test/frieren.jpg') }, role: 'Main',
    voice_actors: [{ person: { name: 'Tanezaki, Atsumi', images: jikanImg('https://cdn.myanimelist.net/images/questionmark_23.gif') }, language: 'Japanese' }],
  }],
};
const jikanStaff = { data: [{ person: { name: 'Saitou, Keiichirou', images: jikanImg('https://cdn.test/s.jpg') }, positions: ['Director'] }] };
const jikanEpisodes = { data: [{ mal_id: 1, filler: false, recap: false }, { mal_id: 2, filler: true, recap: true }], pagination: { has_next_page: false } };

const calls: { url: URL; body?: any }[] = [];
function mockUpstreams(over: Record<string, () => Response> = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    const key = url.host === 'kitsu.app' ? url.pathname.replace('/api/edge', 'kitsu:') : url.pathname;
    if (over[key]) return over[key]();
    if (key === 'kitsu:/anime') return Response.json({ data: [anime], included: categories, meta: { count: 60 } });
    if (key.startsWith('kitsu:/anime/')) return Response.json({ data: anime, included: [...categories, ...mappings] });
    if (key === '/search') return Response.json(apSearch);
    if (key === '/anime/S1/episode') return Response.json(apEpisodes);
    if (key === '/ep/u2') return Response.json(apEp);
    if (key === '/v4/anime/52991/characters') return Response.json(jikanCharacters);
    if (key === '/v4/anime/52991/staff') return Response.json(jikanStaff);
    if (key === '/v4/anime/52991/episodes') return Response.json(jikanEpisodes);
    return new Response('{}', { status: 404 });
  });
}

async function get(path: string) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

afterEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
});

describe('miru catálogo (Kitsu)', () => {
  it('lista airing → filtra por estado, pagina por offset y devuelve el modelo canónico', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/lists/airing?page=2');
    expect(status).toBe(200);
    const q = calls[0].url.searchParams;
    expect([q.get('filter[status]'), q.get('sort'), q.get('page[offset]'), q.get('page[limit]')]).toEqual(['current', 'popularityRank', '20', '20']);
    expect(body).toMatchObject({ page: 2, totalPages: 3, totalResults: 60 });
    expect(body.items[0]).toEqual({
      id: 'kitsu-46474', title: 'Frieren: Beyond Journey’s End',
      alternativeTitles: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End', native: '葬送のフリーレン' },
      synopsis: 'After the party of heroes defeated the Demon King…',
      cover: { sm: 'https://img.test/s.jpg', md: 'https://img.test/m.jpg', lg: 'https://img.test/l.jpg' },
      banner: 'https://img.test/cover.jpg', format: 'TV', status: 'FINISHED', season: 'FALL', year: 2023, episodeCount: 28,
      genres: ['Adventure', 'Drama'], rating: 8.9,
    });
  });

  it('detalle con ids externos de los mapeos', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/anime/kitsu-46474');
    expect(status).toBe(200);
    expect(calls[0].url.pathname).toBe('/api/edge/anime/46474');
    expect(body).toMatchObject({ startDate: '2023-09-29', endDate: '2024-03-22', duration: 24, externalIds: { kitsu: 46474, anilist: 154587, mal: 52991 } });
  });

  it('browse → traduce los filtros canónicos a los de Kitsu', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/browse?season=FALL&year=2026&format=MOVIE&status=RELEASING&genre=slice-of-life&sort=newest');
    expect(status).toBe(200);
    expect(Object.fromEntries([...calls[0].url.searchParams].filter(([k]) => k.startsWith('filter') || k === 'sort'))).toEqual({
      'filter[season]': 'fall', 'filter[seasonYear]': '2026', 'filter[subtype]': 'movie', 'filter[status]': 'current',
      'filter[categories]': 'slice-of-life', sort: '-startDate',
    });
    expect(body.items[0].id).toBe('kitsu-46474');
  });

  it('browse sin filtros → todo por popularidad; filtro inválido → 400', async () => {
    mockUpstreams();
    await get('/miru/browse');
    expect([...calls[0].url.searchParams.keys()].filter((k) => k.startsWith('filter['))).toEqual([]);
    expect(calls[0].url.searchParams.get('sort')).toBe('popularityRank');
    expect((await get('/miru/browse?season=AUTUMN')).status).toBe(400);
  });

  it('schedule → horario de Jikan con ids de Kitsu; sin mapeo o sin hora no sale', async () => {
    const jk = (mal_id: number, day: string | null, time: string | null) => ({
      mal_id, title: `Romaji ${mal_id}`, title_english: mal_id === 1 ? 'English 1' : null, title_japanese: 'ジャ', episodes: 12, aired: { from: mal_id === 1 ? '2026-10-04T00:00:00+00:00' : null },
      images: { jpg: { small_image_url: 's.jpg', image_url: 'm.jpg', large_image_url: 'l.jpg' } },
      broadcast: { day, time, timezone: 'Asia/Tokyo' },
    });
    mockUpstreams({
      // La serie 1 se repite en la página 2: no debe duplicarse.
      '/v4/schedules': () => {
        const page = calls.at(-1)!.url.searchParams.get('page');
        return Response.json(
          page === '1'
            ? { data: [jk(1, 'Sundays', '23:30'), jk(2, 'Mondays', '01:00'), jk(3, null, null)], pagination: { has_next_page: true } }
            : { data: [jk(1, 'Sundays', '23:30'), jk(4, 'Fridays', '12:00')], pagination: { has_next_page: false } },
        );
      },
      'kitsu:/mappings': () =>
        Response.json({
          data: [
            { id: 'm1', type: 'mappings', attributes: { externalId: '1' }, relationships: { item: { data: { type: 'anime', id: '100' } } } },
            { id: 'm2', type: 'mappings', attributes: { externalId: '2' }, relationships: { item: { data: { type: 'anime', id: '200' } } } },
          ],
        }),
    });
    const { status, body } = await get('/miru/schedule');
    expect(status).toBe(200);
    const mappingCall = calls.find((c) => c.url.pathname === '/api/edge/mappings')!;
    expect(mappingCall.url.searchParams.get('filter[externalId]')).toBe('1,2,4'); // la 3 no tiene hora: ni se busca
    expect(body).toEqual([
      { id: 'kitsu-100', title: 'English 1', alternativeTitles: { romaji: 'Romaji 1', english: 'English 1', native: 'ジャ' }, cover: { sm: 's.jpg', md: 'm.jpg', lg: 'l.jpg' }, episodeCount: 12, startDate: '2026-10-04', day: 'SUNDAY', time: '23:30' },
      { id: 'kitsu-200', title: 'Romaji 2', alternativeTitles: { romaji: 'Romaji 2', english: null, native: 'ジャ' }, cover: { sm: 's.jpg', md: 'm.jpg', lg: 'l.jpg' }, episodeCount: 12, startDate: null, day: 'MONDAY', time: '01:00' },
    ]);
  });

  it('id con formato inválido → 400', async () => {
    expect((await get('/miru/anime/anilist-154587')).status).toBe(400);
  });
});

describe('miru reproducción (AnimeParadise)', () => {
  it('episodios de la obra exacta según el id de AniList', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/anime/kitsu-46474/episodes');
    expect(status).toBe(200);
    expect(body).toEqual([
      { number: 1, title: 'The Journey’s End', isFiller: false, isRecap: false },
      { number: 2, title: 'It Didn’t Have to Be Magic', isFiller: true, isRecap: true },
    ]);
  });

  it('playback → HLS con subtítulos, sin cache', async () => {
    mockUpstreams();
    const { status, body, headers } = await get('/miru/playback/kitsu-46474?ep=2');
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(calls.find((c) => c.url.pathname === '/ep/u2')?.url.searchParams.get('origin')).toBe('S1');
    expect(body).toEqual({
      sources: [{
        provider: 'animeparadise', url: 'https://stream.animeparadise.moe/m3u8?url=TOKEN', kind: 'hls', quality: 'auto', language: 'sub',
        subtitles: [{ language: 'es', label: 'Spanish', url: 'https://stream.test/captions?url=x' }],
      }],
      failed: [],
    });
  });

  it('episodio inexistente → 404', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/playback/kitsu-46474?ep=99');
    expect(status).toBe(404);
    expect(body.error.code).toBe('MIRU_NOT_FOUND');
  });

  it('todos los proveedores caídos → 503 con código propio', async () => {
    mockUpstreams({ '/search': () => new Response('boom', { status: 500 }) });
    const { status, body } = await get('/miru/playback/kitsu-46474?ep=1');
    expect(status).toBe(503);
    expect(body.error.code).toBe('MIRU_SOURCE_UNAVAILABLE');
  });
});

describe('miru mapeo de AnimeParadise', () => {
  const ref = { kitsu: 46474, anilist: 154587, mal: 52991, year: 2023, titles: ['Sousou no Frieren'] };
  const entry = (over: object) => ({ _id: 'X', title: 'Sousou no Frieren', posterImage: { medium: 'https://other.test/p.jpg' }, animeSeason: { year: 2023 }, ...over });
  const find = (data: object[]) => {
    mockUpstreams({ '/search': () => Response.json({ data }) });
    return createAnimeParadise(new HttpClient({ retry: false, disableRateLimit: true })).findEntry(ref);
  };

  it('por id de Kitsu en la portada, aunque otra temporada salga antes', async () => {
    expect(await find(apSearch.data)).toBe('animeparadise:S1');
  });

  it('por id de Kitsu en el formato viejo de URL', async () => {
    expect(await find([{ _id: 'O', title: 'x', coverImage: { large: 'https://media.kitsu.app/anime/cover_images/46474/large.jpg' } }])).toBe('animeparadise:O');
  });

  it('por id de AniList en el póster si no hay portada de Kitsu', async () => {
    expect(await find([{ _id: 'A', title: 'x', posterImage: { large: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/large/bx154587-b.jpg' } }])).toBe('animeparadise:A');
  });

  it('obra que no tiene → null (no adivina por título)', async () => {
    expect(await find([apSearch.data[0]])).toBeNull();
  });

  it('sin póster de AniList: título exacto y mismo año → la acepta', async () => {
    expect(await find([entry({})])).toBe('animeparadise:X');
  });

  it('mismo título pero otro año → no', async () => {
    expect(await find([entry({ animeSeason: { year: 2011 } })])).toBeNull();
  });

  it('"Season 2" no iguala al título base', async () => {
    expect(await find([entry({ title: 'Sousou no Frieren Season 2' })])).toBeNull();
  });

  it('con id de otra obra en las imágenes → no, aunque título y año coincidan', async () => {
    expect(await find([entry({ posterImage: { medium: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx999-a.jpg' } })])).toBeNull();
    expect(await find([entry({ coverImage: { large: kitsuImg(999) } })])).toBeNull();
  });
});

describe('miru getPlayback (scatter-gather)', () => {
  const ref = { kitsu: 1, anilist: null, mal: null, year: 2023, titles: ['X'] };
  const src = (provider: string, language: 'sub' | 'dub') => ({ provider, url: `https://${provider}.test/${language}.m3u8`, kind: 'hls' as const, language, subtitles: [] });
  const provider = (id: string, over: Partial<AnimePlaybackProvider> = {}): AnimePlaybackProvider => ({
    id,
    findEntry: async () => `${id}:1`,
    getEpisodes: async () => [{ id: `${id}:1:1`, number: 1, title: 'Ep 1', languages: ['sub', 'dub'] }],
    getSources: async (ep) => ep.languages.map((l) => src(id, l)),
    ...over,
  });

  it('uno caído y otro vivo → devuelve las fuentes del que funciona', async () => {
    const down = provider('down', { getSources: () => Promise.reject(new Error('no video')) });
    const res = await getPlayback(ref, 1, [down, provider('up')]);
    expect(res.sources).toEqual([src('up', 'sub'), src('up', 'dub')]);
    expect(res.failed).toEqual([{ provider: 'down', code: 'MIRU_INTERNAL' }]);
  });

  it('lista de episodios vacía cuenta como "no lo tiene"', async () => {
    const empty = provider('empty', { getEpisodes: async () => [] });
    await expect(getPlayback(ref, 1, [empty])).rejects.toMatchObject({ code: 'MIRU_NOT_FOUND', status: 404 });
  });
});

describe('miru Jikan', () => {
  it('personajes con actores de voz; la foto genérica "?" sale como null', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/anime/kitsu-46474/characters');
    expect(status).toBe(200);
    expect(body).toEqual([{ name: 'Frieren', image: 'https://cdn.test/frieren.jpg', role: 'Main', voiceActors: [{ name: 'Tanezaki, Atsumi', image: null, language: 'Japanese' }] }]);
  });

  it('staff', async () => {
    mockUpstreams();
    const { body } = await get('/miru/anime/kitsu-46474/staff');
    expect(body).toEqual([{ name: 'Saitou, Keiichirou', image: 'https://cdn.test/s.jpg', positions: ['Director'] }]);
  });

  it('Jikan caído → los episodios salen igual, sin marcas', async () => {
    mockUpstreams({ '/v4/anime/52991/episodes': () => new Response('down', { status: 503 }) });
    const { status, body } = await get('/miru/anime/kitsu-6/episodes');
    expect(status).toBe(200);
    expect(body.every((e: any) => !e.isFiller && !e.isRecap)).toBe(true);
  });
});
