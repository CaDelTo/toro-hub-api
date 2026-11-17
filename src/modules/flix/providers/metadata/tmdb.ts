import { withBreaker } from '../../../../shared/breaker';
import { AppError } from '../../../../shared/errors';
import { fetchJson } from '../../../../shared/http';
import type { Collection, DiscoverQuery, Genre, Image, MediaType, Page, Person, Review, Season, TitleDetail, TitleSummary } from '../../domain';
import type { MetadataProvider } from '../../ports';

// Adapter TMDB → modelo canónico de Flix (Anti-Corruption Layer). Nada de TMDB sale de este archivo.

// Base del CDN de imágenes. Se fija al crear el provider (un valor por despliegue).
let IMG = '';

const SIZES = {
  poster: ['w154', 'w342', 'w780'],
  backdrop: ['w780', 'w1280', 'original'],
  profile: ['w185', 'h632', 'original'],
  still: ['w300', 'w780', 'original'],
  logo: ['w92', 'w185', 'w500'],
} as const;

const img = (path: string | null | undefined, kind: keyof typeof SIZES): Image => {
  if (!path) return null;
  const [sm, md, lg] = SIZES[kind];
  return { sm: `${IMG}/${sm}${path}`, md: `${IMG}/${md}${path}`, lg: `${IMG}/${lg}${path}` };
};

// slug, nombre, id TMDB de película, id TMDB de serie (TMDB usa ids distintos para algunos géneros de TV).
const GENRES: [string, string, number | null, number | null][] = [
  ['action', 'Action', 28, 10759],
  ['adventure', 'Adventure', 12, 10759],
  ['animation', 'Animation', 16, 16],
  ['comedy', 'Comedy', 35, 35],
  ['crime', 'Crime', 80, 80],
  ['documentary', 'Documentary', 99, 99],
  ['drama', 'Drama', 18, 18],
  ['family', 'Family', 10751, 10751],
  ['fantasy', 'Fantasy', 14, 10765],
  ['history', 'History', 36, null],
  ['horror', 'Horror', 27, null],
  ['music', 'Music', 10402, null],
  ['mystery', 'Mystery', 9648, 9648],
  ['romance', 'Romance', 10749, null],
  ['sci-fi', 'Sci-Fi', 878, 10765],
  ['thriller', 'Thriller', 53, null],
  ['tv-movie', 'TV Movie', 10770, null],
  ['war', 'War', 10752, 10768],
  ['western', 'Western', 37, 37],
  ['kids', 'Kids', null, 10762],
  ['news', 'News', null, 10763],
  ['reality', 'Reality', null, 10764],
  ['soap', 'Soap', null, 10766],
  ['talk', 'Talk', null, 10767],
];

// Copiado de toro-hub-web/src/utils/genreSubcategories.ts.
// shortcut: el front repite ids (robot = superhero = 9715, dystopia = post-apocalyptic = 4458); verificar en TMDB antes de que el front migre.
const KEYWORDS: Record<string, number> = {
  'time-travel': 4379, alien: 9663, robot: 9715, dystopia: 4458, 'post-apocalyptic': 4458, 'virtual-reality': 158085,
  zombie: 12377, vampire: 1853, werewolf: 16101, superhero: 9715, heist: 10051, spy: 470, 'martial-arts': 9748,
  survival: 10322, 'coming-of-age': 10683, biography: 5565, 'serial-killer': 10714, 'haunted-house': 11324,
  witch: 11949, curse: 1413, anime: 210024, musical: 4344, christmas: 207317, wedding: 9673,
};

const SORT: Record<DiscoverQuery['sort'], Record<MediaType, string>> = {
  popular: { movie: 'popularity.desc', tv: 'popularity.desc' },
  rating: { movie: 'vote_average.desc', tv: 'vote_average.desc' },
  votes: { movie: 'vote_count.desc', tv: 'vote_count.desc' },
  newest: { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  oldest: { movie: 'primary_release_date.asc', tv: 'first_air_date.asc' },
  revenue: { movie: 'revenue.desc', tv: 'popularity.desc' }, // TMDB no tiene revenue en series
  'title-asc': { movie: 'original_title.asc', tv: 'original_name.asc' },
  'title-desc': { movie: 'original_title.desc', tv: 'original_name.desc' },
};

const LISTS: Record<string, Partial<Record<MediaType, string>>> = {
  popular: { movie: '/movie/popular', tv: '/tv/popular' },
  'top-rated': { movie: '/movie/top_rated', tv: '/tv/top_rated' },
  upcoming: { movie: '/movie/upcoming' },
  'now-playing': { movie: '/movie/now_playing' },
  'airing-today': { tv: '/tv/airing_today' },
  'on-the-air': { tv: '/tv/on_the_air' },
};

// ─── Formas crudas de TMDB (solo los campos que se leen) ─────────────────────

type RawPage<T> = { page: number; results: T[]; total_pages: number; total_results: number };
type RawPersonRef = { id: number; name: string; profile_path?: string | null };
type RawTitle = {
  id: number;
  media_type?: string;
  title?: string;
  name?: string;
  original_title?: string;
  original_name?: string;
  overview?: string;
  release_date?: string;
  first_air_date?: string;
  poster_path?: string | null;
  backdrop_path?: string | null;
  genre_ids?: number[];
  genres?: { id: number }[];
  vote_average?: number;
  vote_count?: number;
  popularity?: number;
  original_language?: string;
};
type RawSeason = { season_number: number; name?: string; overview?: string; poster_path?: string | null; air_date?: string | null; episode_count?: number; episodes?: RawEpisode[] };
type RawEpisode = { season_number: number; episode_number: number; name?: string; overview?: string; air_date?: string | null; still_path?: string | null; vote_average?: number; runtime?: number | null };
type RawCompany = { name: string; logo_path?: string | null };
type RawDetail = RawTitle & {
  tagline?: string;
  status?: string;
  runtime?: number | null;
  episode_run_time?: number[];
  homepage?: string | null;
  imdb_id?: string | null;
  budget?: number;
  revenue?: number;
  belongs_to_collection?: { id: number; name: string; poster_path?: string | null; backdrop_path?: string | null } | null;
  number_of_seasons?: number;
  number_of_episodes?: number;
  last_air_date?: string | null;
  last_episode_to_air?: { runtime?: number | null } | null;
  in_production?: boolean;
  seasons?: RawSeason[];
  networks?: RawCompany[];
  production_companies?: RawCompany[];
  created_by?: RawPersonRef[];
  credits?: { cast?: (RawPersonRef & { character?: string; order?: number })[]; crew?: (RawPersonRef & { job?: string; department?: string })[] };
  videos?: { results?: { id: string; key: string; name: string; site: string; type: string; official?: boolean; published_at?: string }[] };
  recommendations?: RawPage<RawTitle>;
  similar?: RawPage<RawTitle>;
  external_ids?: { imdb_id?: string | null; tvdb_id?: number | null };
};
type RawCredit = RawTitle & { character?: string; job?: string; department?: string; episode_count?: number };

// ─── Mapeo ───────────────────────────────────────────────────────────────────

const genreSlugs = (ids: number[], type: MediaType) =>
  GENRES.filter(([, , movie, tv]) => ids.includes((type === 'movie' ? movie : tv) ?? -1)).map(([slug]) => slug);

function toSummary(r: RawTitle, type: MediaType): TitleSummary {
  const date = (type === 'movie' ? r.release_date : r.first_air_date) || null;
  return {
    id: `tmdb-${type}-${r.id}`,
    type,
    title: (type === 'movie' ? r.title : r.name) ?? '',
    originalTitle: (type === 'movie' ? r.original_title : r.original_name) ?? '',
    overview: r.overview ?? '',
    releaseDate: date,
    year: date ? Number(date.slice(0, 4)) : null,
    poster: img(r.poster_path, 'poster'),
    backdrop: img(r.backdrop_path, 'backdrop'),
    genres: genreSlugs(r.genres?.map((g) => g.id) ?? r.genre_ids ?? [], type),
    rating: r.vote_count ? (r.vote_average ?? null) : null,
    voteCount: r.vote_count ?? 0,
    popularity: r.popularity ?? 0,
    originalLanguage: r.original_language ?? '',
  };
}

/** Resultados mixtos (trending/all, search/multi, créditos): descarta personas. */
const mixedType = (r: RawTitle): MediaType | null => (r.media_type === 'movie' || r.media_type === 'tv' ? r.media_type : null);

const toPage = <R, T>(r: RawPage<R>, map: (x: R) => T | null): Page<T> => ({
  items: r.results.map(map).filter((x): x is T => x !== null),
  page: r.page,
  totalPages: Math.min(r.total_pages, 500), // TMDB no sirve más allá de la página 500
  totalResults: r.total_results,
});

const emptyPage = (page: number): Page<never> => ({ items: [], page, totalPages: 0, totalResults: 0 });

const toEpisode = (e: RawEpisode) => ({
  seasonNumber: e.season_number,
  episodeNumber: e.episode_number,
  name: e.name ?? '',
  overview: e.overview ?? '',
  airDate: e.air_date || null,
  still: img(e.still_path, 'still'),
  rating: e.vote_average || null,
  runtime: e.runtime ?? null,
});

const toSeason = (s: RawSeason): Season => ({
  seasonNumber: s.season_number,
  name: s.name ?? '',
  overview: s.overview ?? '',
  poster: img(s.poster_path, 'poster'),
  airDate: s.air_date || null,
  episodeCount: s.episode_count ?? s.episodes?.length ?? 0,
  ...(s.episodes ? { episodes: s.episodes.map(toEpisode) } : {}),
});

const videoUrl = (site: string, key: string) =>
  site === 'YouTube' ? `https://www.youtube.com/watch?v=${key}` : site === 'Vimeo' ? `https://vimeo.com/${key}` : null;

const company = (c: RawCompany) => ({ name: c.name, logo: img(c.logo_path, 'logo') });

/** Algunos avatares de reviews vienen como "/https://…" (gravatar). */
const avatarUrl = (p?: string | null) => (!p ? null : p.startsWith('/http') ? p.slice(1) : `${IMG}/w185${p}`);

function parseId(id: string, kinds: string[]) {
  const m = /^tmdb-([a-z]+)-(\d+)$/.exec(id);
  if (!m || !kinds.includes(m[1])) throw new AppError('flix', 'NOT_FOUND', 404, `Unknown id: ${id}`);
  return { kind: m[1], n: Number(m[2]) };
}

function slugsToIds(csv: string | undefined, table: Record<string, number | null>, what: string): number[] | null {
  if (!csv) return [];
  const ids: number[] = [];
  for (const slug of csv.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(slug in table)) throw new AppError('flix', 'VALIDATION_ERROR', 400, `Unknown ${what}: ${slug}`);
    const id = table[slug];
    if (id === null) return null; // el género no existe para este tipo → no hay resultados
    ids.push(id);
  }
  return [...new Set(ids)];
}

// ─── Adapter ─────────────────────────────────────────────────────────────────

export function createTmdbProvider({ apiKey, apiUrl, imageUrl }: { apiKey: string; apiUrl: string; imageUrl: string }): MetadataProvider {
  const API = apiUrl.replace(/\/$/, '');
  IMG = imageUrl.replace(/\/$/, '');
  const bearer = apiKey.startsWith('eyJ'); // token de lectura v4; si no, api_key v3

  const get = <T>(path: string, params: Record<string, string | number | boolean | undefined> = {}) => {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries({ language: 'en-US', ...params })) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
    if (!bearer) url.searchParams.set('api_key', apiKey);
    return withBreaker('flix:metadata:tmdb', 'flix', () => fetchJson<T>(url, { module: 'flix', headers: bearer ? { Authorization: `Bearer ${apiKey}` } : undefined }));
  };

  return {
    id: 'tmdb',

    genres: (): Genre[] =>
      GENRES.map(([slug, name, movie, tv]) => ({ slug, name, types: [...(movie ? ['movie' as const] : []), ...(tv ? ['tv' as const] : [])] })),

    async list(kind, { type, page, region, window = 'week' }) {
      if (kind === 'trending') {
        const r = await get<RawPage<RawTitle>>(`/trending/${type}/${window}`, { page });
        return toPage(r, (x) => {
          const t = type === 'all' ? mixedType(x) : type;
          return t && toSummary(x, t);
        });
      }
      const path = type !== 'all' ? LISTS[kind][type] : undefined;
      if (!path || type === 'all') throw new AppError('flix', 'VALIDATION_ERROR', 400, `List "${kind}" is not available for type=${type}`);
      const r = await get<RawPage<RawTitle>>(path, { page, region: type === 'movie' ? region : undefined, watch_region: type === 'tv' ? region : undefined });
      return toPage(r, (x) => toSummary(x, type));
    },

    async discover(q) {
      const genreTable = Object.fromEntries(GENRES.map(([slug, , movie, tv]) => [slug, q.type === 'movie' ? movie : tv]));
      const genres = slugsToIds(q.genres, genreTable, 'genre');
      const keywords = slugsToIds(q.keywords, KEYWORDS, 'keyword');
      if (genres === null) return emptyPage(q.page);
      const date = q.type === 'movie' ? 'primary_release_date' : 'first_air_date';
      const r = await get<RawPage<RawTitle>>(`/discover/${q.type}`, {
        page: q.page,
        include_adult: false,
        sort_by: SORT[q.sort][q.type],
        with_genres: genres.join(','),
        with_keywords: keywords?.join('|'),
        [`${date}.gte`]: q.releasedFrom,
        [`${date}.lte`]: q.releasedTo,
        'vote_average.gte': q.minRating,
        'vote_count.gte': q.minVotes,
        'with_runtime.gte': q.minRuntime,
        with_original_language: q.lang,
      });
      return toPage(r, (x) => toSummary(x, q.type));
    },

    async search(query, page) {
      const r = await get<RawPage<RawTitle>>('/search/multi', { query, page, include_adult: false });
      return toPage(r, (x) => {
        const t = mixedType(x);
        return t && toSummary(x, t);
      });
    },

    async getTitle(id): Promise<TitleDetail> {
      const { kind, n } = parseId(id, ['movie', 'tv']);
      const type = kind as MediaType;
      const r = await get<RawDetail>(`/${type}/${n}`, { append_to_response: 'credits,videos,recommendations,similar,external_ids' });
      const base = toSummary(r, type);
      const recs = r.recommendations?.results?.length ? r.recommendations.results : (r.similar?.results ?? []);
      const isMovie = type === 'movie';
      return {
        ...base,
        tagline: r.tagline ?? '',
        status: r.status ?? '',
        runtime: (isMovie ? r.runtime : (r.episode_run_time?.[0] ?? r.last_episode_to_air?.runtime)) || null,
        homepage: r.homepage || null,
        externalIds: { tmdb: r.id, imdb: (r.imdb_id ?? r.external_ids?.imdb_id) || undefined, tvdb: r.external_ids?.tvdb_id || undefined },
        ratings: base.rating === null ? [] : [{ source: 'tmdb', value: base.rating, votes: base.voteCount }],
        companies: (r.production_companies ?? []).map(company),
        cast: (r.credits?.cast ?? []).map((c) => ({ personId: `tmdb-person-${c.id}`, name: c.name, character: c.character ?? '', profile: img(c.profile_path, 'profile'), order: c.order ?? 0 })),
        crew: (r.credits?.crew ?? []).map((c) => ({ personId: `tmdb-person-${c.id}`, name: c.name, job: c.job ?? '', department: c.department ?? '', profile: img(c.profile_path, 'profile') })),
        videos: (r.videos?.results ?? []).map((v) => ({ id: v.id, name: v.name, site: v.site, key: v.key, url: videoUrl(v.site, v.key), type: v.type, official: v.official ?? false, publishedAt: v.published_at ?? null })),
        recommendations: recs.map((x) => toSummary(x, type)),
        budget: isMovie ? (r.budget ?? null) : null,
        revenue: isMovie ? (r.revenue ?? null) : null,
        collection: r.belongs_to_collection
          ? { id: `tmdb-collection-${r.belongs_to_collection.id}`, name: r.belongs_to_collection.name, poster: img(r.belongs_to_collection.poster_path, 'poster'), backdrop: img(r.belongs_to_collection.backdrop_path, 'backdrop') }
          : null,
        seasonCount: isMovie ? null : (r.number_of_seasons ?? null),
        episodeCount: isMovie ? null : (r.number_of_episodes ?? null),
        lastAirDate: r.last_air_date || null,
        inProduction: isMovie ? null : (r.in_production ?? null),
        seasons: (r.seasons ?? []).map(toSeason),
        networks: (r.networks ?? []).map(company),
        createdBy: (r.created_by ?? []).map((p) => ({ personId: `tmdb-person-${p.id}`, name: p.name, profile: img(p.profile_path, 'profile') })),
      };
    },

    async getReviews(id, page) {
      const { kind, n } = parseId(id, ['movie', 'tv']);
      type RawReview = { id: string; author: string; author_details?: { name?: string; rating?: number | null; avatar_path?: string | null }; content: string; created_at: string; updated_at: string; url: string };
      const r = await get<RawPage<RawReview>>(`/${kind}/${n}/reviews`, { page });
      return toPage(r, (x): Review => ({
        id: x.id,
        author: x.author_details?.name || x.author,
        rating: x.author_details?.rating ?? null,
        avatar: avatarUrl(x.author_details?.avatar_path),
        content: x.content,
        createdAt: x.created_at,
        updatedAt: x.updated_at,
        url: x.url,
      }));
    },

    async getSeason(id, season) {
      const { n } = parseId(id, ['tv']);
      return toSeason(await get<RawSeason>(`/tv/${n}/season/${season}`));
    },

    async getCollection(id): Promise<Collection> {
      const { n } = parseId(id, ['collection']);
      const r = await get<{ id: number; name: string; overview?: string; poster_path?: string | null; backdrop_path?: string | null; parts?: RawTitle[] }>(`/collection/${n}`);
      return {
        id,
        name: r.name,
        overview: r.overview ?? '',
        poster: img(r.poster_path, 'poster'),
        backdrop: img(r.backdrop_path, 'backdrop'),
        parts: (r.parts ?? []).map((p) => toSummary(p, 'movie')),
      };
    },

    async getPerson(id): Promise<Person> {
      const { n } = parseId(id, ['person']);
      const r = await get<{
        name: string; biography?: string; birthday?: string | null; deathday?: string | null; place_of_birth?: string | null; profile_path?: string | null;
        known_for_department?: string; also_known_as?: string[]; homepage?: string | null; imdb_id?: string | null;
        combined_credits?: { cast?: RawCredit[]; crew?: RawCredit[] };
      }>(`/person/${n}`, { append_to_response: 'combined_credits' });
      const credit = (c: RawCredit) => {
        const t = mixedType(c);
        return t && { ...toSummary(c, t), character: c.character || null, job: c.job || null, department: c.department || null, episodeCount: c.episode_count ?? null };
      };
      const credits = (list?: RawCredit[]) => (list ?? []).map(credit).filter((c) => c !== null);
      return {
        id,
        name: r.name,
        biography: r.biography ?? '',
        birthday: r.birthday || null,
        deathday: r.deathday || null,
        placeOfBirth: r.place_of_birth || null,
        profile: img(r.profile_path, 'profile'),
        knownFor: r.known_for_department ?? '',
        alsoKnownAs: r.also_known_as ?? [],
        homepage: r.homepage || null,
        imdbId: r.imdb_id || null,
        credits: { cast: credits(r.combined_credits?.cast), crew: credits(r.combined_credits?.crew) },
      };
    },
  };
}
