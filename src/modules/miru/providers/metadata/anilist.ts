import { withBreaker } from '../../../../shared/breaker';
import { AppError } from '../../../../shared/errors';
import { fetchJson } from '../../../../shared/http';
import type { AnimeDetail, AnimeSummary, ListKind, Page } from '../../domain';
import type { AnimeMetadataProvider } from '../../ports';

const API_URL = 'https://graphql.anilist.co';
const PER_PAGE = 20;

const MEDIA = 'id title{romaji english native} description(asHtml:false) format status season seasonYear episodes averageScore genres coverImage{medium large extraLarge} bannerImage';
const DETAIL = `${MEDIA} idMal duration startDate{year month day} endDate{year month day} studios(isMain:true){nodes{name}}`;

// AniList ignora las variables en null, así una sola query sirve para listas y búsqueda.
const PAGE_QUERY = `query($page:Int,$perPage:Int,$sort:[MediaSort],$status:MediaStatus,$search:String){
  Page(page:$page,perPage:$perPage){pageInfo{currentPage lastPage total}
  media(type:ANIME,isAdult:false,sort:$sort,status:$status,search:$search){${MEDIA}}}}`;
const DETAIL_QUERY = `query($id:Int){Media(id:$id,type:ANIME){${DETAIL}}}`;

const LISTS: Record<ListKind, { sort: string; status?: string }> = {
  trending: { sort: 'TRENDING_DESC' },
  popular: { sort: 'POPULARITY_DESC' },
  'top-rated': { sort: 'SCORE_DESC' },
  airing: { sort: 'POPULARITY_DESC', status: 'RELEASING' },
  upcoming: { sort: 'POPULARITY_DESC', status: 'NOT_YET_RELEASED' },
};

type Date3 = { year: number | null; month: number | null; day: number | null } | null;
type Media = {
  id: number;
  idMal?: number | null;
  title: { romaji: string | null; english: string | null; native: string | null };
  description: string | null;
  format: string | null;
  status: string | null;
  season: AnimeSummary['season'];
  seasonYear: number | null;
  episodes: number | null;
  averageScore: number | null;
  genres: string[];
  coverImage: { medium: string | null; large: string | null; extraLarge: string | null } | null;
  bannerImage: string | null;
  duration?: number | null;
  startDate?: Date3;
  endDate?: Date3;
  studios?: { nodes: { name: string }[] };
};

const pad = (n: number) => String(n).padStart(2, '0');
const date = (d: Date3 | undefined) =>
  d?.year ? [String(d.year), ...(d.month ? [pad(d.month)] : []), ...(d.month && d.day ? [pad(d.day)] : [])].join('-') : null;

const toSummary = (m: Media): AnimeSummary => {
  const c = m.coverImage;
  const lg = c?.extraLarge ?? c?.large ?? c?.medium;
  return {
    id: `anilist-${m.id}`,
    title: m.title.english ?? m.title.romaji ?? m.title.native ?? '',
    alternativeTitles: m.title,
    // asHtml:false aún trae <br> e <i>
    synopsis: (m.description ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').trim(),
    cover: lg ? { sm: c?.medium ?? lg, md: c?.large ?? lg, lg } : null,
    banner: m.bannerImage,
    format: m.format,
    status: m.status,
    season: m.season,
    year: m.seasonYear,
    episodeCount: m.episodes,
    genres: m.genres,
    rating: m.averageScore === null ? null : m.averageScore / 10,
  };
};

export function createAnilistProvider(): AnimeMetadataProvider {
  const gql = <T>(query: string, variables: Record<string, unknown>) =>
    withBreaker('miru:metadata:anilist', 'miru', async () => {
      const res = await fetchJson<{ data: T }>(API_URL, { module: 'miru', body: { query, variables } });
      return res.data;
    });

  const page = async (variables: Record<string, unknown>): Promise<Page<AnimeSummary>> => {
    const { Page: p } = await gql<{ Page: { pageInfo: { currentPage: number; lastPage: number; total: number }; media: Media[] } }>(PAGE_QUERY, {
      perPage: PER_PAGE,
      ...variables,
    });
    return { items: p.media.map(toSummary), page: p.pageInfo.currentPage, totalPages: p.pageInfo.lastPage, totalResults: p.pageInfo.total };
  };

  return {
    id: 'anilist',
    list: (kind, p) => page({ page: p, ...LISTS[kind], sort: [LISTS[kind].sort] }),
    search: (q, p) => page({ page: p, search: q, sort: ['SEARCH_MATCH'] }),
    async getAnime(id) {
      const m = /^anilist-(\d+)$/.exec(id);
      if (!m) throw new AppError('miru', 'NOT_FOUND', 404, `Unknown id: ${id}`);
      const { Media: media } = await gql<{ Media: Media | null }>(DETAIL_QUERY, { id: Number(m[1]) });
      if (!media) throw new AppError('miru', 'NOT_FOUND', 404, `Unknown id: ${id}`);
      return {
        ...toSummary(media),
        duration: media.duration ?? null,
        startDate: date(media.startDate),
        endDate: date(media.endDate),
        studios: media.studios?.nodes.map((s) => s.name) ?? [],
        externalIds: { anilist: media.id, mal: media.idMal ?? null },
      } satisfies AnimeDetail;
    },
  };
}
