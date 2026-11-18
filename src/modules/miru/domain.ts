import { z } from '@hono/zod-openapi';
import { pageSchema } from '../../shared/page';

// Modelo canónico de Miru. Ningún campo de AniList ni de AnimeParadise sale de aquí hacia el front.

/** `kitsu-46474`: la fuente forma parte del id. */
export const AnimeId = z.string().regex(/^kitsu-\d+$/).openapi({ example: 'kitsu-46474' });

export const Image = z.object({ sm: z.string(), md: z.string(), lg: z.string() }).nullable().openapi('MiruImage');

export const AnimeSummary = z
  .object({
    id: z.string(),
    title: z.string().openapi({ description: 'Inglés si existe; si no, romaji' }),
    alternativeTitles: z.object({ romaji: z.string().nullable(), english: z.string().nullable(), native: z.string().nullable() }),
    synopsis: z.string(),
    cover: Image,
    banner: z.string().nullable(),
    format: z.string().nullable().openapi({ example: 'TV' }),
    status: z.string().nullable().openapi({ example: 'FINISHED' }),
    season: z.enum(['WINTER', 'SPRING', 'SUMMER', 'FALL']).nullable(),
    year: z.number().int().nullable(),
    episodeCount: z.number().int().nullable(),
    genres: z.array(z.string()),
    rating: z.number().nullable().openapi({ description: '0–10' }),
  })
  .openapi('MiruAnimeSummary');

export const AnimeDetail = AnimeSummary.extend({
  duration: z.number().int().nullable().openapi({ description: 'Minutos por episodio' }),
  startDate: z.string().nullable().openapi({ description: 'YYYY-MM-DD (puede ser parcial: YYYY o YYYY-MM)' }),
  endDate: z.string().nullable(),
  externalIds: z.object({ kitsu: z.number().int(), anilist: z.number().int().nullable(), mal: z.number().int().nullable() }),
}).openapi('MiruAnimeDetail');

export const Episode = z
  .object({
    number: z.number(),
    title: z.string(),
    isFiller: z.boolean().openapi({ description: 'Según MyAnimeList; false si no hay dato' }),
    isRecap: z.boolean(),
  })
  .openapi('MiruEpisode');

const Person = { name: z.string(), image: z.string().nullable() };

export const Character = z
  .object({
    ...Person,
    role: z.string().openapi({ example: 'Main' }),
    voiceActors: z.array(z.object({ ...Person, language: z.string().openapi({ example: 'Japanese' }) })),
  })
  .openapi('MiruCharacter');

export const Staff = z.object({ ...Person, positions: z.array(z.string()) }).openapi('MiruStaff');

export const Subtitle = z.object({ language: z.string().openapi({ example: 'es' }), label: z.string(), url: z.string() }).openapi('MiruSubtitle');

export const Source = z
  .object({
    provider: z.string(),
    url: z.string(),
    kind: z.literal('hls'),
    quality: z.string().optional(),
    language: z.enum(['sub', 'dub']),
    subtitles: z.array(Subtitle),
  })
  .openapi('MiruSource');

export const Playback = z
  .object({
    sources: z.array(Source).openapi({ description: 'Ordenadas por prioridad: el front muestra la primera y permite cambiar' }),
    failed: z.array(z.object({ provider: z.string(), code: z.string() })),
  })
  .openapi('MiruPlayback');

export const AnimePage = pageSchema(AnimeSummary).openapi('MiruAnimePage');

export const ListKind = z.enum(['trending', 'popular', 'top-rated', 'airing', 'upcoming']);

export type AnimeSummary = z.infer<typeof AnimeSummary>;
export type AnimeDetail = z.infer<typeof AnimeDetail>;
export type Episode = z.infer<typeof Episode>;
export type Character = z.infer<typeof Character>;
export type Staff = z.infer<typeof Staff>;
export type Source = z.infer<typeof Source>;
export type Playback = z.infer<typeof Playback>;
export type ListKind = z.infer<typeof ListKind>;
export type Page<T> = { items: T[]; page: number; totalPages: number; totalResults: number };
