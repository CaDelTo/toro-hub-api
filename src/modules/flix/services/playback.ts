import { withBreaker } from '../../../shared/breaker';
import { AppError } from '../../../shared/errors';
import { withTimeout } from '../../../shared/http';
import type { MediaType, Playback, Source } from '../domain';
import type { EpisodeRef, StreamProvider, StreamRef } from '../ports';

const PROVIDER_TIMEOUT_MS = 4000;

/**
 * Scatter-gather: consulta todos los StreamProvider en paralelo, cada uno con timeout y circuit breaker.
 * Un proveedor caído solo aparece en `failed`; solo es error si no queda ninguna fuente.
 * Ojo con el free tier: máximo 50 subrequests por request entre todos los proveedores.
 */
export async function getPlayback(
  id: string,
  ep: EpisodeRef | undefined,
  providers: StreamProvider[],
  resolveImdb: () => Promise<string | undefined>,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<Playback> {
  const m = /^tmdb-(movie|tv)-(\d+)$/.exec(id);
  if (!m) throw new AppError('flix', 'NOT_FOUND', 404, `Unknown id: ${id}`);
  const type = m[1] as MediaType;
  if (type === 'tv' && !ep) throw new AppError('flix', 'VALIDATION_ERROR', 400, 'Query params s and e are required for series');

  const ref: StreamRef = { type, tmdb: Number(m[2]) };
  // Solo se paga el subrequest a TMDB si algún proveedor busca por IMDb.
  if (providers.some((p) => p.needs === 'imdb')) ref.imdb = await resolveImdb().catch(() => undefined);

  const results = await Promise.allSettled(
    providers.map((p) =>
      p.needs === 'imdb' && !ref.imdb
        ? Promise.reject(new AppError('flix', 'NOT_FOUND', 404, 'No IMDb id for this title'))
        : withBreaker(`flix:stream:${p.id}`, 'flix', () => withTimeout(p.getSources(ref, type === 'tv' ? ep : undefined), timeoutMs, 'flix')),
    ),
  );

  const sources: Source[] = [];
  const failed: Playback['failed'] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sources.push(...r.value);
    else failed.push({ provider: providers[i].id, code: r.reason instanceof AppError ? r.reason.code : 'FLIX_INTERNAL' });
  });

  if (!sources.length) throw new AppError('flix', 'SOURCE_UNAVAILABLE', 503, `No playback source available (${failed.map((f) => `${f.provider}: ${f.code}`).join(', ') || 'no providers'})`);
  return { sources, failed };
}
