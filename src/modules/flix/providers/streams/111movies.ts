import type { StreamProvider } from '../../ports';

/** Embed por id de TMDB. Solo arma la URL: no hace subrequests. */
export const create111Movies = (baseUrl: string): StreamProvider => {
  const base = baseUrl.replace(/\/$/, '');
  return {
    id: '111movies',
    needs: 'tmdb',
    async getSources({ type, tmdb }, ep) {
      const url = type === 'movie' ? `${base}/movie/${tmdb}` : `${base}/tv/${tmdb}/${ep!.season}/${ep!.episode}`;
      return [{ provider: '111movies', url, kind: 'embed' }];
    },
  };
};
