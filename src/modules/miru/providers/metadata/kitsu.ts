import { withBreaker } from '../../../../shared/breaker';
import { AppError } from '../../../../shared/errors';
import { fetchJson } from '../../../../shared/http';
import type { AnimeDetail, AnimeSummary, ListKind, Page } from '../../domain';
import type { AnimeMetadataProvider } from '../../ports';

// Kitsu (JSON:API) en vez de AniList: AniList bloquea a mano las IPs de Cloudflare Workers (403 "manually blocked").
const API_URL = 'https://kitsu.app/api/edge';
const PER_PAGE = 20; // máximo de Kitsu
const HOUR = 3600;

// Kitsu no tiene un "trending" útil (/trending/anime devuelve 10 títulos viejos): se usa lo más popular del año.
// Función y no constante: en Workers, Date en el ámbito global vale 1970.
const LISTS: Record<ListKind, () => Record<string, string>> = {
  trending: () => ({ 'filter[seasonYear]': String(new Date().getUTCFullYear()), sort: 'popularityRank' }),
  popular: () => ({ sort: 'popularityRank' }),
  'top-rated': () => ({ sort: 'ratingRank' }),
  airing: () => ({ 'filter[status]': 'current', sort: 'popularityRank' }),
  upcoming: () => ({ 'filter[status]': 'upcoming', sort: 'popularityRank' }),
};

type Img = { tiny?: string; small?: string; medium?: string; large?: string; original?: string } | null;
type Resource = { id: string; type: string; attributes: Record<string, unknown>; relationships?: Record<string, { data?: { id: string; type: string }[] }> };
type Anime = Resource & {
  attributes: {
    canonicalTitle: string;
    titles: { en?: string; en_jp?: string; ja_jp?: string };
    synopsis: string | null;
    subtype: string | null;
    status: string | null;
    startDate: string | null;
    endDate: string | null;
    episodeCount: number | null;
    episodeLength: number | null;
    averageRating: string | null;
    posterImage: Img;
    coverImage: Img;
  };
};
type Doc<T> = { data: T; included?: Resource[]; meta?: { count?: number } };

const FORMAT: Record<string, string> = { TV: 'TV', movie: 'MOVIE', OVA: 'OVA', ONA: 'ONA', special: 'SPECIAL', music: 'MUSIC' };
const STATUS: Record<string, string> = { current: 'RELEASING', finished: 'FINISHED', upcoming: 'NOT_YET_RELEASED', unreleased: 'NOT_YET_RELEASED', tba: 'NOT_YET_RELEASED' };
// Temporadas de anime (como AniList): invierno dic–feb, primavera mar–may, verano jun–ago, otoño sep–nov.
const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'] as const;

/** Títulos de las categorías incluidas (`include=categories`) que pertenecen a este anime. */
const genres = (a: Anime, included: Resource[] = []) => {
  const ids = new Set(a.relationships?.categories?.data?.map((c) => c.id));
  return included.filter((r) => r.type === 'categories' && ids.has(r.id)).map((r) => String(r.attributes.title));
};

function toSummary(a: Anime, included?: Resource[]): AnimeSummary {
  const t = a.attributes;
  const p = t.posterImage;
  const lg = p?.large ?? p?.original ?? p?.medium;
  const month = t.startDate ? Number(t.startDate.slice(5, 7)) : 0;
  return {
    id: `kitsu-${a.id}`,
    title: t.titles.en ?? t.canonicalTitle,
    alternativeTitles: { romaji: t.titles.en_jp ?? null, english: t.titles.en ?? null, native: t.titles.ja_jp ?? null },
    synopsis: (t.synopsis ?? '').trim(),
    cover: lg ? { sm: p?.small ?? lg, md: p?.medium ?? lg, lg } : null,
    banner: t.coverImage?.large ?? t.coverImage?.original ?? null,
    format: t.subtype ? (FORMAT[t.subtype] ?? t.subtype.toUpperCase()) : null,
    status: t.status ? (STATUS[t.status] ?? t.status.toUpperCase()) : null,
    season: month ? SEASONS[Math.floor((month % 12) / 3)] : null,
    year: t.startDate ? Number(t.startDate.slice(0, 4)) : null,
    episodeCount: t.episodeCount,
    genres: genres(a, included),
    rating: t.averageRating ? Math.round(Number(t.averageRating)) / 10 : null,
  };
}

export function createKitsuProvider(): AnimeMetadataProvider {
  const get = <T>(path: string, params: Record<string, string>) => {
    const url = new URL(`${API_URL}${path}`);
    for (const [k, v] of Object.entries({ 'fields[categories]': 'title', ...params })) url.searchParams.set(k, v);
    return withBreaker('miru:metadata:kitsu', 'miru', () =>
      fetchJson<Doc<T>>(url, { module: 'miru', cacheTtl: HOUR, headers: { Accept: 'application/vnd.api+json' } }),
    );
  };

  const page = async (params: Record<string, string>, p: number): Promise<Page<AnimeSummary>> => {
    const doc = await get<Anime[]>('/anime', { ...params, include: 'categories', 'page[limit]': String(PER_PAGE), 'page[offset]': String((p - 1) * PER_PAGE) });
    const total = doc.meta?.count ?? doc.data.length;
    return { items: doc.data.map((a) => toSummary(a, doc.included)), page: p, totalPages: Math.max(1, Math.ceil(total / PER_PAGE)), totalResults: total };
  };

  return {
    id: 'kitsu',
    list: (kind, p) => page(LISTS[kind](), p),
    search: (q, p) => page({ 'filter[text]': q }, p),
    async getAnime(id) {
      const m = /^kitsu-(\d+)$/.exec(id);
      if (!m) throw new AppError('miru', 'NOT_FOUND', 404, `Unknown id: ${id}`);
      const doc = await get<Anime>(`/anime/${m[1]}`, { include: 'categories,mappings', 'fields[mappings]': 'externalSite,externalId' });
      const external = (site: string) => {
        const hit = doc.included?.find((r) => r.type === 'mappings' && r.attributes.externalSite === site);
        return hit ? Number(hit.attributes.externalId) || null : null;
      };
      const t = doc.data.attributes;
      return {
        ...toSummary(doc.data, doc.included),
        duration: t.episodeLength,
        startDate: t.startDate,
        endDate: t.endDate,
        externalIds: { kitsu: Number(doc.data.id), anilist: external('anilist/anime'), mal: external('myanimelist/anime') },
      } satisfies AnimeDetail;
    },
  };
}
