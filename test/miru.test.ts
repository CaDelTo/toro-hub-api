import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpClient } from 'anime-sdk';
import app from '../src/index';
import type { AnimePlaybackProvider } from '../src/modules/miru/ports';
import { createAnimeParadise } from '../src/modules/miru/providers/playback/animeparadise';
import { getPlayback } from '../src/modules/miru/services/playback';

// Fixtures recortados de respuestas reales de AniList y AnimeParadise.
const media = {
  id: 154587, idMal: 52991,
  title: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End', native: '葬送のフリーレン' },
  description: 'The adventure is over<br><br>but <i>life</i> goes on.', format: 'TV', status: 'FINISHED', season: 'FALL', seasonYear: 2023,
  episodes: 28, averageScore: 91, genres: ['Adventure', 'Drama'],
  coverImage: { medium: 'https://img.test/m.jpg', large: 'https://img.test/l.jpg', extraLarge: 'https://img.test/xl.jpg' },
  bannerImage: null, duration: 24, startDate: { year: 2023, month: 9, day: 29 }, endDate: { year: 2024, month: 3, day: null },
  studios: { nodes: [{ name: 'MADHOUSE' }] },
};
// La temporada 2 aparece primero en la búsqueda: el mapeo debe elegir por id de AniList, no por orden.
const apSearch = {
  data: [
    { _id: 'S2', title: 'Sousou no Frieren 2', posterImage: { medium: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx182255-a.jpg' } },
    { _id: 'S1', title: 'Sousou no Frieren', posterImage: { medium: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx154587-b.jpg' } },
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
    const key = url.host === 'graphql.anilist.co' ? (body.query.includes('Page(') ? 'anilist:page' : 'anilist:media') : url.pathname;
    if (over[key]) return over[key]();
    if (key === 'anilist:page') return Response.json({ data: { Page: { pageInfo: { currentPage: 1, lastPage: 3, total: 60 }, media: [media] } } });
    if (key === 'anilist:media') return Response.json({ data: { Media: media } });
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

describe('miru catálogo (AniList)', () => {
  it('lista airing → filtra por estado y devuelve el modelo canónico', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/lists/airing?page=2');
    expect(status).toBe(200);
    expect(calls[0].body.variables).toMatchObject({ page: 2, sort: ['POPULARITY_DESC'], status: 'RELEASING' });
    expect(body).toMatchObject({ page: 1, totalPages: 3, totalResults: 60 });
    expect(body.items[0]).toEqual({
      id: 'anilist-154587', title: 'Frieren: Beyond Journey’s End',
      alternativeTitles: { romaji: 'Sousou no Frieren', english: 'Frieren: Beyond Journey’s End', native: '葬送のフリーレン' },
      synopsis: 'The adventure is over\n\nbut life goes on.',
      cover: { sm: 'https://img.test/m.jpg', md: 'https://img.test/l.jpg', lg: 'https://img.test/xl.jpg' },
      banner: null, format: 'TV', status: 'FINISHED', season: 'FALL', year: 2023, episodeCount: 28, genres: ['Adventure', 'Drama'], rating: 9.1,
    });
  });

  it('detalle con fechas parciales, estudios e ids externos', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/anime/anilist-154587');
    expect(status).toBe(200);
    expect(calls[0].body.variables).toEqual({ id: 154587 });
    expect(body).toMatchObject({ startDate: '2023-09-29', endDate: '2024-03', duration: 24, studios: ['MADHOUSE'], externalIds: { anilist: 154587, mal: 52991 } });
  });

  it('id con formato inválido → 400', async () => {
    expect((await get('/miru/anime/154587')).status).toBe(400);
  });
});

describe('miru reproducción (AnimeParadise)', () => {
  it('episodios de la obra exacta según el id de AniList', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/anime/anilist-154587/episodes');
    expect(status).toBe(200);
    expect(body).toEqual([
      { number: 1, title: 'The Journey’s End', isFiller: false, isRecap: false },
      { number: 2, title: 'It Didn’t Have to Be Magic', isFiller: true, isRecap: true },
    ]);
  });

  it('playback → HLS con subtítulos, sin cache', async () => {
    mockUpstreams();
    const { status, body, headers } = await get('/miru/playback/anilist-154587?ep=2');
    expect(status).toBe(200);
    expect(headers.get('Cache-Control')).toBe('no-store');
    expect(calls.find((c) => c.url.pathname === '/ep/u2')?.url.searchParams.get('origin')).toBe('S1');
    expect(body).toEqual({
      sources: [{
        provider: 'animeparadise', url: 'https://stream.animeparadise.moe/m3u8?url=TOKEN', kind: 'hls', quality: 'auto', language: 'sub',
        subtitles: [{ language: 'es', label: 'Spanish', url: 'https://stream.test/captions?url=x' }],
      }],
      // MegaPlay se consulta también; aquí su embed no existe y queda en `failed` sin tumbar la respuesta.
      failed: [{ provider: 'megaplay', code: 'MIRU_UPSTREAM_ERROR' }],
    });
  });

  it('episodio inexistente → 404', async () => {
    mockUpstreams();
    const { status, body } = await get('/miru/playback/anilist-154587?ep=99');
    expect(status).toBe(404);
    expect(body.error.code).toBe('MIRU_NOT_FOUND');
  });

  it('todos los proveedores caídos → 503 con código propio', async () => {
    mockUpstreams({ '/search': () => new Response('boom', { status: 500 }) });
    const { status, body } = await get('/miru/playback/anilist-154587?ep=1');
    expect(status).toBe(503);
    expect(body.error.code).toBe('MIRU_SOURCE_UNAVAILABLE');
  });
});

describe('miru mapeo de AnimeParadise', () => {
  const ref = { anilist: 154587, mal: 52991, year: 2023, titles: ['Sousou no Frieren'] };
  const entry = (over: object) => ({ _id: 'X', title: 'Sousou no Frieren', posterImage: { medium: 'https://kitsu.test/p.jpg' }, animeSeason: { year: 2023 }, ...over });
  const find = (data: object[]) => {
    mockUpstreams({ '/search': () => Response.json({ data }) });
    return createAnimeParadise(new HttpClient({ retry: false, disableRateLimit: true })).findEntry(ref);
  };

  it('por id de AniList en el póster, aunque otra temporada salga antes', async () => {
    expect(await find(apSearch.data)).toBe('animeparadise:S1');
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

  it('con póster de AniList de otra obra → no, aunque título y año coincidan', async () => {
    expect(await find([entry({ posterImage: { medium: 'https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/bx999-a.jpg' } })])).toBeNull();
  });
});

describe('miru getPlayback (scatter-gather)', () => {
  const ref = { anilist: 1, mal: null, year: 2023, titles: ['X'] };
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
    const { status, body } = await get('/miru/anime/anilist-154587/characters');
    expect(status).toBe(200);
    expect(body).toEqual([{ name: 'Frieren', image: 'https://cdn.test/frieren.jpg', role: 'Main', voiceActors: [{ name: 'Tanezaki, Atsumi', image: null, language: 'Japanese' }] }]);
  });

  it('staff', async () => {
    mockUpstreams();
    const { body } = await get('/miru/anime/anilist-154587/staff');
    expect(body).toEqual([{ name: 'Saitou, Keiichirou', image: 'https://cdn.test/s.jpg', positions: ['Director'] }]);
  });

  it('Jikan caído → los episodios salen igual, sin marcas', async () => {
    mockUpstreams({ '/v4/anime/52991/episodes': () => new Response('down', { status: 503 }) });
    const { status, body } = await get('/miru/anime/anilist-6/episodes');
    expect(status).toBe(200);
    expect(body.every((e: any) => !e.isFiller && !e.isRecap)).toBe(true);
  });
});
