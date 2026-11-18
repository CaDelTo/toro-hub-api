export type Bindings = {
  ENABLED_MODULES: string;
  TMDB_API_KEY?: string;
  SITE_PASSWORD?: string;
  JWT_SECRET?: string;
  /** p. ej. ".toro-hub.x" para compartir la sesión entre subdominios; vacío en local. */
  COOKIE_DOMAIN?: string;
  // URLs de proveedores externos: fuera del repo (secrets en Cloudflare, .dev.vars en local).
  TMDB_API_URL?: string;
  TMDB_IMAGE_URL?: string;
  /** Base del embed del player (equivale a NEXT_PUBLIC_PLAYER_BASE_URL del front). Sin ella no hay fuentes de reproducción. */
  PLAYER_BASE_URL?: string;
  /** Fuentes extra: JSON [{"id","movie","tv"}] con plantillas {tmdb} {imdb} {s} {e} (providers/streams/embed.ts). */
  STREAM_PROVIDERS?: string;
  /** Notas de IMDb y RT (providers/metadata/omdb.ts). Opcionales: sin ellas el detalle trae solo la de TMDB. */
  OMDB_API_KEY?: string;
  OMDB_API_URL?: string;
};

export type AppEnv = { Bindings: Bindings };
