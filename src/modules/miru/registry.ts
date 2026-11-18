import { HttpClient } from 'anime-sdk';
import type { AnimeEnricher, AnimeMetadataProvider, AnimePlaybackProvider } from './ports';
import { createAnilistProvider } from './providers/metadata/anilist';
import { createJikanEnricher } from './providers/metadata/jikan';
import { createAnimeParadise } from './providers/playback/animeparadise';
import { createMegaPlay } from './providers/playback/megaplay';

// Proveedores activos de Miru. Agregar uno = crear su adapter y sumarlo aquí.

export const METADATA_ID = 'anilist';

export const metadataProvider = (): AnimeMetadataProvider => createAnilistProvider();

/** Personajes, staff y marcas de relleno, por id de MyAnimeList. */
export const enricher = (): AnimeEnricher => createJikanEnricher();

/**
 * En orden de prioridad: el primero es la fuente por defecto del reproductor. Se consultan todos en paralelo.
 * Solo proveedores con mapeo exacto de la obra. Anikoto y AllManga quedan fuera: solo mapean por título
 * difuso (10–13 s por consulta) y en noviembre de 2026 no devolvían vídeo.
 */
export function playbackProviders(): AnimePlaybackProvider[] {
  // Timeout, reintentos y circuit breaker los pone services/playback.ts.
  const http = new HttpClient({ retry: false, disableRateLimit: true });
  return [createAnimeParadise(http), createMegaPlay(http)];
}
