import { fetchJson } from '../../../../shared/http';
import type { Rating } from '../../domain';
import type { RatingsEnricher } from '../../ports';

type OmdbResponse = {
  Response: 'True' | 'False';
  imdbRating?: string;
  imdbVotes?: string;
  Ratings?: { Source: string; Value: string }[];
};

/**
 * Notas de IMDb y Rotten Tomatoes por id de IMDb (OMDb). Todas en escala 0–10 como la de TMDB:
 * RT "93%" → 9.3; el front la muestra en porcentaje.
 */
export function createOmdbEnricher({ apiKey, apiUrl }: { apiKey: string; apiUrl: string }): RatingsEnricher {
  return {
    id: 'omdb',
    async ratings(imdbId) {
      const url = new URL(apiUrl);
      url.searchParams.set('apikey', apiKey);
      url.searchParams.set('i', imdbId);
      // Las notas cambian poco y el plan gratuito da 1000 consultas al día: un día de cache de borde.
      const body = await fetchJson<OmdbResponse>(url, { module: 'flix', timeoutMs: 2500, cacheTtl: 86400 });
      return body.Response === 'True' ? parseOmdb(body) : [];
    },
  };
}

export function parseOmdb(body: OmdbResponse): Rating[] {
  const out: Rating[] = [];
  const imdb = Number(body.imdbRating);
  const votes = Number(body.imdbVotes?.replaceAll(',', ''));
  if (imdb > 0) out.push({ source: 'imdb', value: imdb, ...(Number.isInteger(votes) && votes > 0 ? { votes } : {}) });
  const rt = /^(\d{1,3})%$/.exec(body.Ratings?.find((r) => r.Source === 'Rotten Tomatoes')?.Value ?? '');
  if (rt) out.push({ source: 'rt', value: Number(rt[1]) / 10 });
  return out;
}
