import { z } from 'zod';
import type { StreamProvider } from '../../ports';

/**
 * Proveedor de embed definido por configuración (STREAM_PROVIDERS), sin código por sitio.
 * Plantillas: {tmdb}, {imdb}, {s} (temporada) y {e} (episodio). Si usa {imdb}, la API resuelve ese id antes.
 */
export const EmbedConfig = z.object({
  id: z.string().min(1),
  movie: z.url(),
  tv: z.url(),
});
export type EmbedConfig = z.infer<typeof EmbedConfig>;

export function createEmbedProvider(c: EmbedConfig): StreamProvider {
  return {
    id: c.id,
    needs: c.movie.includes('{imdb}') || c.tv.includes('{imdb}') ? 'imdb' : 'tmdb',
    async getSources({ type, tmdb, imdb }, ep) {
      const url = (type === 'movie' ? c.movie : c.tv)
        .replaceAll('{tmdb}', String(tmdb))
        .replaceAll('{imdb}', imdb ?? '')
        .replaceAll('{s}', String(ep?.season ?? 1))
        .replaceAll('{e}', String(ep?.episode ?? 1));
      return [{ provider: c.id, url, kind: 'embed' }];
    },
  };
}

/** JSON de STREAM_PROVIDERS → configs válidas. Un valor inválido se ignora (y se registra) para no tumbar el playback. */
export function parseEmbedConfigs(raw: string | undefined): EmbedConfig[] {
  if (!raw?.trim()) return [];
  try {
    return z.array(EmbedConfig).parse(JSON.parse(raw));
  } catch (err) {
    console.error('[flix] STREAM_PROVIDERS inválido, se ignora:', err instanceof Error ? err.message : err);
    return [];
  }
}
