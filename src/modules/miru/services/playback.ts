import { withBreaker } from '../../../shared/breaker';
import { AppError } from '../../../shared/errors';
import { withTimeout } from '../../../shared/http';
import type { Episode, Playback, Source } from '../domain';
import type { AnimeEnricher, AnimePlaybackProvider, AnimeRef, EpisodeUnit } from '../ports';

// Buscar la obra + listar episodios + resolver el stream son 3–4 llamadas seguidas al proveedor, y en series
// largas la lista pesa (ONE PIECE: ~340 KB, ~5 s en AnimeParadise). Con 8 s, esos títulos abrían el breaker para todos.
const PROVIDER_TIMEOUT_MS = 15_000;
// Las marcas de relleno son un extra: no esperamos a Jikan más que esto.
const ENRICH_TIMEOUT_MS = 4000;

const guarded = <T>(p: AnimePlaybackProvider, fn: () => Promise<T>, timeoutMs: number) =>
  withBreaker(`miru:playback:${p.id}`, 'miru', () => withTimeout(fn(), timeoutMs, 'miru'));

async function episodesOf(p: AnimePlaybackProvider, ref: AnimeRef): Promise<EpisodeUnit[]> {
  const entry = await p.findEntry(ref);
  const units = entry ? await p.getEpisodes(entry) : [];
  if (!units.length) throw new AppError('miru', 'NOT_FOUND', 404, `Not available on ${p.id}`);
  return units;
}

/** Episodios del primer proveedor que tenga la obra (fallback en orden de prioridad). */
async function firstEpisodes(ref: AnimeRef, providers: AnimePlaybackProvider[], timeoutMs: number) {
  let lastErr: unknown = new AppError('miru', 'SOURCE_UNAVAILABLE', 503, 'No playback providers');
  for (const p of providers) {
    try {
      return await guarded(p, () => episodesOf(p, ref), timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

/** Episodios reproducibles con marcas de relleno/recap. Si el enriquecedor falla, salen sin marcas. */
export async function getEpisodes(ref: AnimeRef, providers: AnimePlaybackProvider[], enricher: AnimeEnricher, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<Episode[]> {
  const none = { filler: new Set<number>(), recap: new Set<number>() };
  const [units, flags] = await Promise.all([
    firstEpisodes(ref, providers, timeoutMs),
    ref.mal === null ? none : withTimeout(enricher.getEpisodeFlags(ref.mal), Math.min(timeoutMs, ENRICH_TIMEOUT_MS), 'miru').catch(() => none),
  ]);
  return units.map(({ number, title }) => ({ number, title, isFiller: flags.filler.has(number), isRecap: flags.recap.has(number) }));
}

/** Scatter-gather como en Flix: un proveedor caído solo aparece en `failed`; es error si no queda ninguna fuente. */
export async function getPlayback(ref: AnimeRef, episode: number, providers: AnimePlaybackProvider[], timeoutMs = PROVIDER_TIMEOUT_MS): Promise<Playback> {
  const results = await Promise.allSettled(
    providers.map((p) =>
      guarded(
        p,
        async () => {
          const ep = (await episodesOf(p, ref)).find((e) => e.number === episode);
          if (!ep) throw new AppError('miru', 'NOT_FOUND', 404, `Episode ${episode} not available on ${p.id}`);
          return p.getSources(ep);
        },
        timeoutMs,
      ),
    ),
  );

  const sources: Source[] = [];
  const failed: Playback['failed'] = [];
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') sources.push(...r.value);
    else failed.push({ provider: providers[i].id, code: r.reason instanceof AppError ? r.reason.code : 'MIRU_INTERNAL' });
  });

  if (!sources.length) {
    const notFound = failed.length > 0 && failed.every((f) => f.code === 'MIRU_NOT_FOUND');
    throw new AppError('miru', notFound ? 'NOT_FOUND' : 'SOURCE_UNAVAILABLE', notFound ? 404 : 503, `No playback source available (${failed.map((f) => `${f.provider}: ${f.code}`).join(', ') || 'no providers'})`);
  }
  return { sources, failed };
}
