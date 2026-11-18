import { HttpClient } from 'anime-sdk';
import type { AnimeEnricher, AnimeMetadataProvider, AnimePlaybackProvider } from './ports';
import { createJikanEnricher } from './providers/metadata/jikan';
import { createKitsuProvider } from './providers/metadata/kitsu';
import { createAnimeParadise } from './providers/playback/animeparadise';

// Proveedores activos de Miru. Agregar uno = crear su adapter y sumarlo aquí.

export const METADATA_ID = 'kitsu';

export const metadataProvider = (): AnimeMetadataProvider => createKitsuProvider();

/** Personajes, staff y marcas de relleno, por id de MyAnimeList. */
export const enricher = (): AnimeEnricher => createJikanEnricher();

/**
 * En orden de prioridad: el primero es la fuente por defecto del reproductor. Se consultan todos en paralelo.
 * Solo proveedores con mapeo exacto de la obra. Fuera: MegaPlay (saca los episodios de AniList, que bloquea
 * Cloudflare Workers) y Anikoto/AllManga (mapeo por título difuso de 10–13 s). Ninguno devolvía vídeo en noviembre de 2026.
 */
export function playbackProviders(): AnimePlaybackProvider[] {
  // Timeout, reintentos y circuit breaker los pone services/playback.ts.
  const http = new HttpClient({ retry: false, disableRateLimit: true });
  return [createAnimeParadise(http)];
}
