import type { Bindings } from '../../env';
import { AppError } from '../../shared/errors';
import type { MetadataProvider, RatingsEnricher, StreamProvider } from './ports';
import { createOmdbEnricher } from './providers/metadata/omdb';
import { createTmdbProvider } from './providers/metadata/tmdb';
import { create111Movies } from './providers/streams/111movies';
import { createEmbedProvider, parseEmbedConfigs } from './providers/streams/embed';

// Proveedores activos de Flix. Agregar uno = crear su adapter y sumarlo aquí.
// Enriquecedores de metadata: opcionales, se activan con su secret.

export const METADATA_ID = 'tmdb';

export function metadataProvider(env: Bindings): MetadataProvider {
  const { TMDB_API_KEY: apiKey, TMDB_API_URL: apiUrl, TMDB_IMAGE_URL: imageUrl } = env;
  if (!apiKey || !apiUrl || !imageUrl) throw new AppError('flix', 'NOT_CONFIGURED', 503, 'TMDB_API_KEY, TMDB_API_URL and TMDB_IMAGE_URL must be set');
  return createTmdbProvider({ apiKey, apiUrl, imageUrl });
}

/** Notas de IMDb y RT (OMDb). Sin OMDB_API_KEY y OMDB_API_URL no hay enriquecedor y el detalle trae solo TMDB. */
export const ratingsEnricher = (env: Bindings): RatingsEnricher | null =>
  env.OMDB_API_KEY && env.OMDB_API_URL ? createOmdbEnricher({ apiKey: env.OMDB_API_KEY, apiUrl: env.OMDB_API_URL }) : null;

/** En orden de prioridad: el primero es la fuente por defecto del reproductor. Los de STREAM_PROVIDERS van después. */
export const streamProviders = (env: Bindings): StreamProvider[] => [
  ...(env.PLAYER_BASE_URL ? [create111Movies(env.PLAYER_BASE_URL)] : []),
  ...parseEmbedConfigs(env.STREAM_PROVIDERS).map(createEmbedProvider),
];
