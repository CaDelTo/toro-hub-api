import { AnimeParadiseProvider, type HttpClient } from 'anime-sdk';
import { fetchJson } from '../../../../shared/http';
import type { AnimePlaybackProvider } from '../../ports';
import { fromSdk } from './sdk';

const API_BASE = 'https://api.animeparadise.moe';

type RawEntry = {
  _id: string;
  title: string;
  alternativeTitle?: { english?: string; romaji?: string; native?: string };
  posterImage?: { medium?: string; large?: string };
  coverImage?: { large?: string; tiny?: string };
  animeSeason?: { year?: number };
  startDate?: string;
};

// Sin quitar sufijos de temporada (normalizeTitle del SDK los quita): "X Season 2" no debe igualar a "X".
const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const yearOf = (e: RawEntry) => e.animeSeason?.year ?? (e.startDate ? Number(e.startDate.slice(0, 4)) : null);

// Ids que delatan la obra en las imágenes de AnimeParadise: Kitsu en la portada, AniList en el póster.
const kitsuOf = (e: RawEntry) => /media\.kitsu\.app\/anime\/(?:cover_images\/)?(\d+)\//.exec(e.coverImage?.large ?? e.coverImage?.tiny ?? '')?.[1];
const anilistOf = (e: RawEntry) => /anilistcdn\/media\/anime\/cover\/\w+\/bx?(\d+)-/.exec(e.posterImage?.large ?? e.posterImage?.medium ?? '')?.[1];

/**
 * AnimeParadise vía anime-sdk. Sus imágenes vienen de Kitsu (portada) y AniList (póster) con el id en la URL:
 * la obra se identifica por cualquiera de los dos. Solo si la entrada no trae ninguno se acepta título exacto + mismo año.
 * La búsqueda va directa al API porque el SDK descarta el año y las imágenes.
 */
export function createAnimeParadise(http: HttpClient): AnimePlaybackProvider {
  return fromSdk(new AnimeParadiseProvider(http), async ({ kitsu, anilist, titles, year }) => {
    const wanted = new Set(titles.map(norm));
    for (const q of titles) {
      const url = `${API_BASE}/search?q=${encodeURIComponent(q)}&limit=20`;
      const { data = [] } = await fetchJson<{ data?: RawEntry[] }>(url, { module: 'miru' });
      const hit =
        data.find((e) => kitsuOf(e) === String(kitsu) || (anilist !== null && anilistOf(e) === String(anilist))) ??
        data.find(
          (e) =>
            !kitsuOf(e) && !anilistOf(e) && // con un id en las imágenes ya sabemos que es otra obra
            year !== null &&
            yearOf(e) === year &&
            [e.title, e.alternativeTitle?.english, e.alternativeTitle?.romaji].some((t) => t && wanted.has(norm(t))),
        );
      if (hit) return `animeparadise:${hit._id}`; // URN del SDK
    }
    return null;
  });
}
