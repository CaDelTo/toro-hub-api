import { AnimeParadiseProvider, HttpClient } from 'anime-sdk';
import { AppError } from '../../../../shared/errors';
import { fetchJson } from '../../../../shared/http';
import type { Source } from '../../domain';
import type { AnimePlaybackProvider } from '../../ports';

const API_BASE = 'https://api.animeparadise.moe';

type RawEntry = {
  _id: string;
  title: string;
  alternativeTitle?: { english?: string; romaji?: string; native?: string };
  posterImage?: { medium?: string; large?: string };
  animeSeason?: { year?: number };
  startDate?: string;
};

// Sin quitar sufijos de temporada (normalizeTitle del SDK los quita): "X Season 2" no debe igualar a "X".
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const yearOf = (e: RawEntry) => e.animeSeason?.year ?? (e.startDate ? Number(e.startDate.slice(0, 4)) : null);

/**
 * AnimeParadise vía anime-sdk. Casi todos sus pósters son del CDN de AniList (`.../bx154587-xxx.jpg`): la obra
 * se identifica por ese id. Si la entrada no trae póster de AniList, se acepta solo con título exacto y mismo año.
 * La búsqueda va directa al API porque el SDK descarta el año.
 */
export function createAnimeParadise(): AnimePlaybackProvider {
  // Timeout, reintentos y circuit breaker los pone services/playback.ts.
  const sdk = new AnimeParadiseProvider(new HttpClient({ retry: false, disableRateLimit: true }));
  const upstream = <T>(p: Promise<T>) =>
    p.catch((err) => {
      throw err instanceof AppError ? err : new AppError('miru', 'UPSTREAM_ERROR', 502, `animeparadise: ${err instanceof Error ? err.message : err}`);
    });

  return {
    id: 'animeparadise',
    async findEntry({ anilist, titles, year }) {
      const samePoster = new RegExp(`/bx?${anilist}-`);
      const wanted = new Set(titles.map(norm));
      for (const q of titles) {
        const url = `${API_BASE}/search?q=${encodeURIComponent(q)}&limit=20`;
        const { data = [] } = await fetchJson<{ data?: RawEntry[] }>(url, { module: 'miru' });
        const poster = (e: RawEntry) => e.posterImage?.medium ?? e.posterImage?.large ?? '';
        const hit =
          data.find((e) => samePoster.test(poster(e))) ??
          data.find(
            (e) =>
              !poster(e).includes('anilistcdn') && // con póster de AniList ya sabemos que es otra obra
              year !== null &&
              yearOf(e) === year &&
              [e.title, e.alternativeTitle?.english, e.alternativeTitle?.romaji].some((t) => t && wanted.has(norm(t))),
          );
        if (hit) return `animeparadise:${hit._id}`; // URN del SDK
      }
      return null;
    },
    async getEpisodes(entryId) {
      return (await upstream(sdk.fetchContentUnits(entryId))).map((u) => ({ id: u.id, number: u.number, title: u.title }));
    },
    async getSources(episodeId) {
      const res = await upstream(sdk.resolveStream(episodeId, 'sub'));
      if (res.type !== 'video') return [];
      return res.streams.map(
        (s): Source => ({
          provider: 'animeparadise',
          url: s.sourceUrl,
          kind: 'hls',
          quality: s.quality,
          language: s.language === 'dub' ? 'dub' : 'sub',
          subtitles: (s.subtitles ?? []).map((t) => ({ language: t.language, label: t.label, url: t.url })),
        }),
      );
    },
  };
}
