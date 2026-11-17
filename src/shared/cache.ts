import { cache } from 'hono/cache';

/**
 * Cache-Aside en el borde (Cache API de Cloudflare) + Cache-Control para CDN y navegador.
 * Solo cachea 200. Ojo: registrar DESPUÉS de cualquier middleware de auth, o se sirven respuestas sin verificar sesión.
 * En *.workers.dev la Cache API no guarda nada (requiere dominio propio).
 */
export const cacheFor = (module: string, seconds: number) =>
  cache({
    cacheName: `${module}-v1`, // subir la versión invalida todo el cache del módulo
    cacheControl: `public, max-age=${Math.min(seconds, 600)}, s-maxage=${seconds}`,
    onCacheNotAvailable: false,
  });
