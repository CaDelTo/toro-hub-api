import type { Bindings } from '../../env';
import { AppError } from '../../shared/errors';
import type { MetadataProvider, StreamProvider } from './ports';
import { createTmdbProvider } from './providers/metadata/tmdb';
import { create111Movies } from './providers/streams/111movies';

// Proveedores activos de Flix. Agregar uno = crear su adapter y sumarlo aquí.
// Fallback y enriquecedores de metadata (OMDb) se registran aquí cuando lleguen.

export const METADATA_ID = 'tmdb';

export function metadataProvider(env: Bindings): MetadataProvider {
  const { TMDB_API_KEY: apiKey, TMDB_API_URL: apiUrl, TMDB_IMAGE_URL: imageUrl } = env;
  if (!apiKey || !apiUrl || !imageUrl) throw new AppError('flix', 'NOT_CONFIGURED', 503, 'TMDB_API_KEY, TMDB_API_URL and TMDB_IMAGE_URL must be set');
  return createTmdbProvider({ apiKey, apiUrl, imageUrl });
}

/** En orden de prioridad: el primero es la fuente por defecto del reproductor. */
export const streamProviders = (env: Bindings): StreamProvider[] => [env.PLAYER_BASE_URL && create111Movies(env.PLAYER_BASE_URL)].filter((p) => !!p);
