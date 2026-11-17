import { z } from '@hono/zod-openapi';
import { pageSchema } from '../../shared/page';

// Modelo canónico de Flix. Ningún nombre de campo de TMDB sale de aquí hacia el front.

export const MediaType = z.enum(['movie', 'tv']).openapi('FlixMediaType');

/** URLs completas en tres tamaños; el front nunca arma rutas de imagen. */
export const Image = z
  .object({ sm: z.string(), md: z.string(), lg: z.string() })
  .nullable()
  .openapi('FlixImage');

/** `tmdb-movie-603`, `tmdb-tv-1399`: la fuente y el tipo forman parte del id. */
export const TitleId = z.string().regex(/^[a-z0-9]+-(movie|tv)-[a-z0-9]+$/).openapi({ example: 'tmdb-movie-603' });

export const TitleSummary = z
  .object({
    id: z.string(),
    type: MediaType,
    title: z.string(),
    originalTitle: z.string(),
    overview: z.string(),
    releaseDate: z.string().nullable().openapi({ description: 'YYYY-MM-DD (estreno o primera emisión)' }),
    year: z.number().int().nullable(),
    poster: Image,
    backdrop: Image,
    genres: z.array(z.string()).openapi({ description: 'Slugs propios (ver /flix/genres)' }),
    rating: z.number().nullable().openapi({ description: '0–10' }),
    voteCount: z.number().int(),
    popularity: z.number(),
    originalLanguage: z.string(),
  })
  .openapi('FlixTitleSummary');

export const Rating = z.object({ source: z.enum(['tmdb', 'imdb', 'rt']), value: z.number(), votes: z.number().int().optional() }).openapi('FlixRating');

export const Video = z
  .object({
    id: z.string(),
    name: z.string(),
    site: z.string(),
    key: z.string(),
    url: z.string().nullable(),
    type: z.string().openapi({ example: 'Trailer' }),
    official: z.boolean(),
    publishedAt: z.string().nullable(),
  })
  .openapi('FlixVideo');

export const CastMember = z
  .object({ personId: z.string(), name: z.string(), character: z.string(), profile: Image, order: z.number().int() })
  .openapi('FlixCastMember');

export const CrewMember = z
  .object({ personId: z.string(), name: z.string(), job: z.string(), department: z.string(), profile: Image })
  .openapi('FlixCrewMember');

export const Episode = z
  .object({
    seasonNumber: z.number().int(),
    episodeNumber: z.number().int(),
    name: z.string(),
    overview: z.string(),
    airDate: z.string().nullable(),
    still: Image,
    rating: z.number().nullable(),
    runtime: z.number().int().nullable(),
  })
  .openapi('FlixEpisode');

export const Season = z
  .object({
    seasonNumber: z.number().int(),
    name: z.string(),
    overview: z.string(),
    poster: Image,
    airDate: z.string().nullable(),
    episodeCount: z.number().int(),
    episodes: z.array(Episode).optional().openapi({ description: 'Solo en /seasons/:n' }),
  })
  .openapi('FlixSeason');

const Company = z.object({ name: z.string(), logo: Image });

export const TitleDetail = TitleSummary.extend({
  tagline: z.string(),
  status: z.string(),
  runtime: z.number().int().nullable().openapi({ description: 'Minutos (en series, duración típica de episodio)' }),
  homepage: z.string().nullable(),
  externalIds: z.object({ tmdb: z.number().int().optional(), imdb: z.string().optional(), tvdb: z.number().int().optional() }),
  ratings: z.array(Rating),
  companies: z.array(Company),
  cast: z.array(CastMember),
  crew: z.array(CrewMember),
  videos: z.array(Video),
  recommendations: z.array(TitleSummary),
  // Solo películas (null en series)
  budget: z.number().nullable(),
  revenue: z.number().nullable(),
  collection: z.object({ id: z.string(), name: z.string(), poster: Image, backdrop: Image }).nullable(),
  // Solo series (null / vacío en películas)
  seasonCount: z.number().int().nullable(),
  episodeCount: z.number().int().nullable(),
  lastAirDate: z.string().nullable(),
  inProduction: z.boolean().nullable(),
  seasons: z.array(Season),
  networks: z.array(Company),
  createdBy: z.array(z.object({ personId: z.string(), name: z.string(), profile: Image })),
}).openapi('FlixTitleDetail');

export const Review = z
  .object({
    id: z.string(),
    author: z.string(),
    rating: z.number().nullable(),
    avatar: z.string().nullable(),
    content: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    url: z.string(),
  })
  .openapi('FlixReview');

export const Collection = z
  .object({ id: z.string(), name: z.string(), overview: z.string(), poster: Image, backdrop: Image, parts: z.array(TitleSummary) })
  .openapi('FlixCollection');

export const PersonCredit = TitleSummary.extend({
  character: z.string().nullable(),
  job: z.string().nullable(),
  department: z.string().nullable(),
  episodeCount: z.number().int().nullable(),
}).openapi('FlixPersonCredit');

export const Person = z
  .object({
    id: z.string(),
    name: z.string(),
    biography: z.string(),
    birthday: z.string().nullable(),
    deathday: z.string().nullable(),
    placeOfBirth: z.string().nullable(),
    profile: Image,
    knownFor: z.string(),
    alsoKnownAs: z.array(z.string()),
    homepage: z.string().nullable(),
    imdbId: z.string().nullable(),
    credits: z.object({ cast: z.array(PersonCredit), crew: z.array(PersonCredit) }),
  })
  .openapi('FlixPerson');

export const Genre = z
  .object({ slug: z.string(), name: z.string(), types: z.array(MediaType) })
  .openapi('FlixGenre');

export const Source = z
  .object({
    provider: z.string(),
    url: z.string(),
    kind: z.enum(['embed', 'hls']).openapi({ description: '`embed` → iframe; `hls` → reproductor propio' }),
    quality: z.string().optional(),
  })
  .openapi('FlixSource');

export const Playback = z
  .object({
    sources: z.array(Source).openapi({ description: 'Ordenadas por prioridad: el front muestra la primera y permite cambiar' }),
    failed: z.array(z.object({ provider: z.string(), code: z.string() })).openapi({ description: 'Proveedores que fallaron en esta consulta' }),
  })
  .openapi('FlixPlayback');

export const TitlePage = pageSchema(TitleSummary).openapi('FlixTitlePage');
export const ReviewPage = pageSchema(Review).openapi('FlixReviewPage');

export const ListKind = z.enum(['trending', 'popular', 'top-rated', 'upcoming', 'now-playing', 'airing-today', 'on-the-air']);
export const SortKey = z.enum(['popular', 'rating', 'votes', 'newest', 'oldest', 'revenue', 'title-asc', 'title-desc']);

export const DiscoverQuery = z.object({
  type: MediaType,
  genres: z.string().optional().openapi({ description: 'Slugs separados por coma (todos deben cumplirse)', example: 'crime,thriller' }),
  keywords: z.string().optional().openapi({ description: 'Slugs separados por coma (basta uno)', example: 'witch,curse' }),
  sort: SortKey.default('popular'),
  releasedFrom: z.iso.date().optional(),
  releasedTo: z.iso.date().optional(),
  minRating: z.coerce.number().min(0).max(10).optional(),
  minVotes: z.coerce.number().int().min(0).optional(),
  minRuntime: z.coerce.number().int().min(0).optional(),
  lang: z.string().length(2).optional().openapi({ description: 'Idioma original, ISO 639-1' }),
  page: z.coerce.number().int().min(1).max(500).default(1),
});

export type MediaType = z.infer<typeof MediaType>;
export type Image = z.infer<typeof Image>;
export type TitleSummary = z.infer<typeof TitleSummary>;
export type TitleDetail = z.infer<typeof TitleDetail>;
export type Season = z.infer<typeof Season>;
export type Review = z.infer<typeof Review>;
export type Collection = z.infer<typeof Collection>;
export type Person = z.infer<typeof Person>;
export type Genre = z.infer<typeof Genre>;
export type Source = z.infer<typeof Source>;
export type Playback = z.infer<typeof Playback>;
export type ListKind = z.infer<typeof ListKind>;
export type DiscoverQuery = z.infer<typeof DiscoverQuery>;
export type Page<T> = { items: T[]; page: number; totalPages: number; totalResults: number };
