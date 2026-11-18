import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';

// Fixtures recortados de respuestas reales de TMDB (solo los campos que el adapter lee).
const movie = {
  id: 603, title: 'The Matrix', original_title: 'The Matrix', overview: 'Neo…', release_date: '1999-03-31',
  poster_path: '/p.jpg', backdrop_path: '/b.jpg', genre_ids: [28, 878], vote_average: 8.2, vote_count: 26000, popularity: 90, original_language: 'en',
};
const tv = {
  id: 1399, name: 'Game of Thrones', original_name: 'Game of Thrones', overview: '', first_air_date: '2011-04-17',
  poster_path: null, backdrop_path: null, genre_ids: [10765, 18, 10759], vote_average: 0, vote_count: 0, popularity: 50, original_language: 'en',
};
const page = (results: unknown[]) => ({ page: 1, results, total_pages: 900, total_results: 18000 });

const calls: URL[] = [];
function mockTmdb(routes: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push(url);
    const body = routes[url.pathname.replace('/3', '')];
    return body === undefined ? new Response('{}', { status: 404 }) : Response.json(body);
  });
}

async function get(path: string, extraEnv: Record<string, unknown> = { TMDB_API_KEY: 'v3key' }) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

afterEach(() => {
  vi.restoreAllMocks();
  calls.length = 0;
});

describe('flix /lists', () => {
  it('popular de películas → modelo canónico', async () => {
    mockTmdb({ '/movie/popular': page([movie]) });
    const { status, body, headers } = await get('/flix/lists/popular?type=movie&region=CO');
    expect(status).toBe(200);
    expect(calls[0].searchParams.get('region')).toBe('CO');
    expect(calls[0].searchParams.get('api_key')).toBe('v3key');
    expect(body.totalPages).toBe(500); // TMDB no sirve más allá de 500
    expect(body.items[0]).toEqual({
      id: 'tmdb-movie-603', type: 'movie', title: 'The Matrix', originalTitle: 'The Matrix', overview: 'Neo…',
      releaseDate: '1999-03-31', year: 1999,
      poster: { sm: 'https://img.test/t/p/w154/p.jpg', md: 'https://img.test/t/p/w342/p.jpg', lg: 'https://img.test/t/p/w780/p.jpg' },
      backdrop: { sm: 'https://img.test/t/p/w780/b.jpg', md: 'https://img.test/t/p/w1280/b.jpg', lg: 'https://img.test/t/p/original/b.jpg' },
      genres: ['action', 'sci-fi'], rating: 8.2, voteCount: 26000, popularity: 90, originalLanguage: 'en',
    });
    expect(headers.get('cache-control')).toBe('public, max-age=600, s-maxage=3600');
  });

  it('series: géneros de TV a slugs, sin votos → rating null, sin imagen → null', async () => {
    mockTmdb({ '/tv/top_rated': page([tv]) });
    const { body } = await get('/flix/lists/top-rated?type=tv');
    expect(body.items[0]).toMatchObject({ id: 'tmdb-tv-1399', title: 'Game of Thrones', year: 2011, poster: null, rating: null, genres: ['action', 'adventure', 'drama', 'fantasy', 'sci-fi'] });
  });

  it('trending all descarta personas', async () => {
    mockTmdb({ '/trending/all/day': page([{ ...movie, media_type: 'movie' }, { id: 1, media_type: 'person', name: 'X' }, { ...tv, media_type: 'tv' }]) });
    const { body } = await get('/flix/lists/trending?type=all&window=day');
    expect(body.items.map((i: { id: string }) => i.id)).toEqual(['tmdb-movie-603', 'tmdb-tv-1399']);
  });

  it('lista que no existe para el tipo → 400', async () => {
    const { status, body } = await get('/flix/lists/upcoming?type=tv');
    expect(status).toBe(400);
    expect(body.error.code).toBe('FLIX_VALIDATION_ERROR');
  });
});

describe('flix /discover', () => {
  it('traduce filtros propios a params de TMDB (series)', async () => {
    mockTmdb({ '/discover/tv': page([tv]) });
    const { status } = await get('/flix/discover?type=tv&genres=action,sci-fi&keywords=witch,curse&sort=newest&releasedFrom=2010-01-01&releasedTo=2019-12-31&minRating=7&minVotes=100&lang=ko&page=3');
    expect(status).toBe(200);
    expect(Object.fromEntries(calls[0].searchParams)).toEqual({
      language: 'en-US', api_key: 'v3key', page: '3', include_adult: 'false', sort_by: 'first_air_date.desc',
      with_genres: '10759,10765', with_keywords: '11949|1413',
      'first_air_date.gte': '2010-01-01', 'first_air_date.lte': '2019-12-31',
      'vote_average.gte': '7', 'vote_count.gte': '100', with_original_language: 'ko',
    });
  });

  it('género sin equivalente en series → página vacía sin llamar a TMDB', async () => {
    mockTmdb({});
    const { body } = await get('/flix/discover?type=tv&genres=horror');
    expect(body).toEqual({ items: [], page: 1, totalPages: 0, totalResults: 0 });
    expect(calls).toHaveLength(0);
  });

  it('slug desconocido → 400', async () => {
    const { status, body } = await get('/flix/discover?type=movie&genres=nope');
    expect(status).toBe(400);
    expect(body.error.message).toContain('nope');
  });

  it('falta type → 400 con la forma común', async () => {
    const { status, body } = await get('/flix/discover');
    expect(status).toBe(400);
    expect(body.error.code).toBe('FLIX_VALIDATION_ERROR');
  });
});

describe('flix /titles', () => {
  it('detalle de película en un solo fetch', async () => {
    mockTmdb({
      '/movie/603': {
        ...movie, genres: [{ id: 28 }], tagline: 'Free your mind', status: 'Released', runtime: 136, homepage: '', imdb_id: 'tt0133093',
        budget: 63000000, revenue: 463517383, belongs_to_collection: { id: 2344, name: 'The Matrix Collection', poster_path: null, backdrop_path: null },
        production_companies: [{ name: 'Warner Bros.', logo_path: '/wb.png' }],
        credits: { cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Neo', profile_path: null, order: 0 }], crew: [{ id: 9339, name: 'Lana Wachowski', job: 'Director', department: 'Directing' }] },
        videos: { results: [{ id: 'v1', key: 'abc', name: 'Trailer', site: 'YouTube', type: 'Trailer', official: true, published_at: '2020-01-01' }] },
        recommendations: page([]),
        similar: page([{ ...movie, id: 604 }]),
        external_ids: { imdb_id: 'tt0133093' },
      },
    });
    const { body } = await get('/flix/titles/tmdb-movie-603');
    expect(calls).toHaveLength(1);
    expect(calls[0].searchParams.get('append_to_response')).toBe('credits,videos,recommendations,similar,external_ids');
    expect(body).toMatchObject({
      id: 'tmdb-movie-603', genres: ['action'], tagline: 'Free your mind', runtime: 136, homepage: null,
      externalIds: { tmdb: 603, imdb: 'tt0133093' }, ratings: [{ source: 'tmdb', value: 8.2, votes: 26000 }],
      collection: { id: 'tmdb-collection-2344', name: 'The Matrix Collection' },
      cast: [{ personId: 'tmdb-person-6384', name: 'Keanu Reeves', character: 'Neo', profile: null, order: 0 }],
      crew: [{ personId: 'tmdb-person-9339', job: 'Director' }],
      videos: [{ key: 'abc', url: 'https://www.youtube.com/watch?v=abc', official: true }],
      recommendations: [{ id: 'tmdb-movie-604' }], // sin recomendaciones → cae a similares
      seasonCount: null, seasons: [], inProduction: null,
    });
  });

  it('detalle de serie: duración de episodio y temporadas', async () => {
    mockTmdb({
      '/tv/1399': {
        ...tv, episode_run_time: [], last_episode_to_air: { runtime: 80 }, number_of_seasons: 8, number_of_episodes: 73, in_production: false,
        seasons: [{ season_number: 1, name: 'Season 1', episode_count: 10, air_date: '2011-04-17', poster_path: '/s1.jpg' }],
        external_ids: { imdb_id: 'tt0944947', tvdb_id: 121361 },
      },
    });
    const { body } = await get('/flix/titles/tmdb-tv-1399');
    expect(body).toMatchObject({ runtime: 80, seasonCount: 8, episodeCount: 73, budget: null, externalIds: { imdb: 'tt0944947', tvdb: 121361 } });
    expect(body.seasons[0]).toEqual({ seasonNumber: 1, name: 'Season 1', overview: '', poster: expect.any(Object), airDate: '2011-04-17', episodeCount: 10 });
  });

  describe('notas de OMDb', () => {
    // Un id por test: las respuestas de TMDB y OMDb quedan en la cache de borde entre tests.
    const detail = (id: number) => ({ ...tv, id, vote_average: 8.4, vote_count: 24000, external_ids: { imdb_id: `tt${id}` } });
    const omdbEnv = { TMDB_API_KEY: 'v3key', OMDB_API_KEY: 'omdbkey', OMDB_API_URL: 'https://omdb.test/' };

    it('suma IMDb y RT (en escala 0–10) a la de TMDB', async () => {
      mockTmdb({
        '/tv/1401': detail(1401),
        '/': { Response: 'True', imdbRating: '9.2', imdbVotes: '2,345,678', Ratings: [{ Source: 'Internet Movie Database', Value: '9.2/10' }, { Source: 'Rotten Tomatoes', Value: '89%' }] },
      });
      const { status, body } = await get('/flix/titles/tmdb-tv-1401', omdbEnv);
      expect(status).toBe(200);
      expect(body.ratings).toEqual([
        { source: 'tmdb', value: 8.4, votes: 24000 },
        { source: 'imdb', value: 9.2, votes: 2345678 },
        { source: 'rt', value: 8.9 },
      ]);
      const omdbCall = calls.find((u) => u.host === 'omdb.test')!;
      expect(omdbCall.searchParams.get('i')).toBe('tt1401');
      expect(omdbCall.searchParams.get('apikey')).toBe('omdbkey');
    });

    it('valores N/A y "Response: False" → sin notas extra', async () => {
      mockTmdb({ '/tv/1402': detail(1402), '/': { Response: 'True', imdbRating: 'N/A', imdbVotes: 'N/A', Ratings: [] } });
      expect((await get('/flix/titles/tmdb-tv-1402', omdbEnv)).body.ratings).toEqual([{ source: 'tmdb', value: 8.4, votes: 24000 }]);
      mockTmdb({ '/tv/1405': detail(1405), '/': { Response: 'False', Error: 'Incorrect IMDb ID.' } });
      expect((await get('/flix/titles/tmdb-tv-1405', omdbEnv)).body.ratings).toHaveLength(1);
    });

    it('si OMDb falla, el detalle sale igual con la nota de TMDB', async () => {
      mockTmdb({ '/tv/1403': detail(1403) }); // OMDb → 404
      const { status, body } = await get('/flix/titles/tmdb-tv-1403', omdbEnv);
      expect(status).toBe(200);
      expect(body.ratings).toEqual([{ source: 'tmdb', value: 8.4, votes: 24000 }]);
    });

    it('sin OMDB_API_KEY no se llama a OMDb', async () => {
      mockTmdb({ '/tv/1404': detail(1404) });
      await get('/flix/titles/tmdb-tv-1404');
      expect(calls.some((u) => u.host === 'omdb.test')).toBe(false);
    });
  });

  it('temporada con episodios', async () => {
    mockTmdb({ '/tv/1399/season/1': { season_number: 1, name: 'Season 1', episodes: [{ season_number: 1, episode_number: 1, name: 'Winter Is Coming', still_path: '/e.jpg', vote_average: 8, runtime: 62 }] } });
    const { body } = await get('/flix/titles/tmdb-tv-1399/seasons/1');
    expect(body.episodeCount).toBe(1);
    expect(body.episodes[0]).toMatchObject({ episodeNumber: 1, name: 'Winter Is Coming', runtime: 62, still: { sm: 'https://img.test/t/p/w300/e.jpg' } });
  });

  it('temporada de una película → 404', async () => {
    const { status, body } = await get('/flix/titles/tmdb-movie-603/seasons/1');
    expect(status).toBe(404);
    expect(body.error.code).toBe('FLIX_NOT_FOUND');
  });

  it('reseñas: avatar gravatar y avatar de TMDB', async () => {
    const review = { id: 'r', author: 'joe', content: 'Great', created_at: 'c', updated_at: 'u', url: 'x' };
    mockTmdb({
      '/movie/603/reviews': page([
        { ...review, author_details: { name: '', rating: 9, avatar_path: '/https://gravatar.com/a.jpg' } },
        { ...review, author_details: { name: 'Joe', rating: null, avatar_path: '/a.jpg' } },
      ]),
    });
    const { body } = await get('/flix/titles/tmdb-movie-603/reviews');
    expect(body.items.map((r: { author: string; avatar: string }) => [r.author, r.avatar])).toEqual([
      ['joe', 'https://gravatar.com/a.jpg'],
      ['Joe', 'https://img.test/t/p/w185/a.jpg'],
    ]);
  });

  it('id con formato inválido → 400; id de otro proveedor → 404', async () => {
    expect((await get('/flix/titles/603')).status).toBe(400);
    expect((await get('/flix/titles/imdb-movie-tt1')).status).toBe(404);
  });

  it('TMDB 404 → FLIX_NOT_FOUND', async () => {
    mockTmdb({});
    const { status, body } = await get('/flix/titles/tmdb-movie-999999');
    expect(status).toBe(404);
    expect(body.error.code).toBe('FLIX_NOT_FOUND');
  });
});

describe('flix /people, /collections, /search', () => {
  it('persona: créditos mixtos sin entradas desconocidas', async () => {
    mockTmdb({
      '/person/6384': {
        name: 'Keanu Reeves', biography: 'b', birthday: '1964-09-02', profile_path: '/k.jpg', known_for_department: 'Acting',
        combined_credits: { cast: [{ ...movie, media_type: 'movie', character: 'Neo' }, { ...tv, media_type: 'tv', character: 'Self', episode_count: 2 }], crew: [] },
      },
    });
    const { body } = await get('/flix/people/tmdb-person-6384');
    expect(body).toMatchObject({ id: 'tmdb-person-6384', name: 'Keanu Reeves', deathday: null, knownFor: 'Acting' });
    expect(body.credits.cast.map((c: { id: string; character: string; episodeCount: number | null }) => [c.id, c.character, c.episodeCount])).toEqual([
      ['tmdb-movie-603', 'Neo', null],
      ['tmdb-tv-1399', 'Self', 2],
    ]);
  });

  it('colección', async () => {
    mockTmdb({ '/collection/2344': { id: 2344, name: 'The Matrix Collection', parts: [movie] } });
    const { body } = await get('/flix/collections/tmdb-collection-2344');
    expect(body).toMatchObject({ id: 'tmdb-collection-2344', parts: [{ id: 'tmdb-movie-603' }] });
  });

  it('search multi sin personas y sin adultos', async () => {
    mockTmdb({ '/search/multi': page([{ ...movie, media_type: 'movie' }, { id: 1, media_type: 'person' }]) });
    const { body } = await get('/flix/search?q=matrix');
    expect(calls[0].searchParams.get('include_adult')).toBe('false');
    expect(body.items).toHaveLength(1);
  });
});

describe('flix configuración', () => {
  it('token v4 va por header Bearer, no en la URL', async () => {
    mockTmdb({ '/movie/now_playing': page([]) });
    await get('/flix/lists/now-playing', { TMDB_API_KEY: 'eyJtoken' });
    expect(calls[0].searchParams.has('api_key')).toBe(false);
    const init = vi.mocked(fetch).mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer eyJtoken');
  });

  it('sin TMDB_API_KEY → 503 FLIX_NOT_CONFIGURED', async () => {
    const { status, body } = await get('/flix/titles/tmdb-movie-1', { TMDB_API_KEY: undefined });
    expect(status).toBe(503);
    expect(body.error.code).toBe('FLIX_NOT_CONFIGURED');
  });

  it('/flix/genres incluye tipos', async () => {
    const { body } = await get('/flix/genres');
    expect(body).toContainEqual({ slug: 'horror', name: 'Horror', types: ['movie'] });
    expect(body).toContainEqual({ slug: 'kids', name: 'Kids', types: ['tv'] });
  });

  it('módulo desactivado por ENABLED_MODULES → 404', async () => {
    const { status } = await get('/flix/genres', { ENABLED_MODULES: 'auth', TMDB_API_KEY: 'k' });
    expect(status).toBe(404);
  });

  it('OpenAPI documenta las rutas de flix', async () => {
    const { body } = await get('/openapi.json');
    expect(Object.keys(body.paths)).toEqual(expect.arrayContaining(['/flix/titles/{id}', '/flix/discover', '/flix/lists/{kind}']));
    expect(body.components.schemas).toHaveProperty('FlixTitleDetail');
  });
});
