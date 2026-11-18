import type { AnimeEnricher, AnimeMetadataProvider, AnimePlaybackProvider } from './ports';
import { createAnilistProvider } from './providers/metadata/anilist';
import { createJikanEnricher } from './providers/metadata/jikan';
import { createAnimeParadise } from './providers/playback/animeparadise';

// Proveedores activos de Miru. Agregar uno = crear su adapter y sumarlo aquí.

export const METADATA_ID = 'anilist';

export const metadataProvider = (): AnimeMetadataProvider => createAnilistProvider();

/** Personajes, staff y marcas de relleno, por id de MyAnimeList. */
export const enricher = (): AnimeEnricher => createJikanEnricher();

/** En orden de prioridad: el primero es la fuente por defecto del reproductor. */
export const playbackProviders = (): AnimePlaybackProvider[] => [createAnimeParadise()];
