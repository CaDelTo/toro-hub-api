import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import type { StreamProvider } from '../src/modules/flix/ports';
import { getPlayback } from '../src/modules/flix/services/playback';
import { breakerState, withBreaker } from '../src/shared/breaker';
import { AppError } from '../src/shared/errors';
import { withTimeout } from '../src/shared/http';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function get(path: string, extraEnv: Record<string, unknown> = {}) {
  const ctx = createExecutionContext();
  const res = await app.request(path, {}, { ...env, TMDB_API_KEY: 'k', ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

describe('circuit breaker', () => {
  const boom = () => Promise.reject(new AppError('flix', 'UPSTREAM_ERROR', 502, 'x'));

  it('abre tras 3 caídas, corta sin llamar y se reabre con un fallo tras el cooldown', async () => {
    vi.useFakeTimers();
    const fn = vi.fn(boom);
    for (let i = 0; i < 3; i++) await expect(withBreaker('t:open', 'flix', fn)).rejects.toMatchObject({ code: 'FLIX_UPSTREAM_ERROR' });
    expect(breakerState('t:open')).toBe('open');
    await expect(withBreaker('t:open', 'flix', fn)).rejects.toMatchObject({ code: 'FLIX_UPSTREAM_UNAVAILABLE', status: 503 });
    expect(fn).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(30_001); // half-open
    expect(breakerState('t:open')).toBe('closed');
    await expect(withBreaker('t:open', 'flix', fn)).rejects.toMatchObject({ code: 'FLIX_UPSTREAM_ERROR' });
    expect(breakerState('t:open')).toBe('open');
  });

  it('un éxito resetea el contador', async () => {
    for (let i = 0; i < 2; i++) await withBreaker('t:reset', 'flix', boom).catch(() => {});
    await withBreaker('t:reset', 'flix', async () => 1);
    for (let i = 0; i < 2; i++) await withBreaker('t:reset', 'flix', boom).catch(() => {});
    expect(breakerState('t:reset')).toBe('closed');
  });

  it('los 404 no cuentan como caída', async () => {
    const notFound = () => Promise.reject(new AppError('flix', 'NOT_FOUND', 404, 'x'));
    for (let i = 0; i < 5; i++) await withBreaker('t:404', 'flix', notFound).catch(() => {});
    expect(breakerState('t:404')).toBe('closed');
  });

  it('withTimeout rechaza con UPSTREAM_TIMEOUT', async () => {
    await expect(withTimeout(new Promise(() => {}), 10, 'flix')).rejects.toMatchObject({ code: 'FLIX_UPSTREAM_TIMEOUT', status: 504 });
  });
});

describe('getPlayback (scatter-gather)', () => {
  const ok = (id: string, needs: 'tmdb' | 'imdb' = 'tmdb'): StreamProvider => ({
    id,
    needs,
    getSources: async (ref, ep) => [{ provider: id, url: `https://${id}/${ref.imdb ?? ref.tmdb}/${ep ? `${ep.season}x${ep.episode}` : ''}`, kind: 'embed' }],
  });
  const failing = (id: string): StreamProvider => ({ id, needs: 'tmdb', getSources: () => Promise.reject(new Error('down')) });
  const hanging = (id: string): StreamProvider => ({ id, needs: 'tmdb', getSources: () => new Promise(() => {}) });
  const noImdb = async () => undefined;

  it('mantiene el orden de prioridad y reporta los que fallan', async () => {
    const r = await getPlayback('tmdb-movie-603', undefined, [failing('a'), ok('b'), hanging('c'), ok('d')], noImdb, 20);
    expect(r.sources.map((s) => s.provider)).toEqual(['b', 'd']);
    expect(r.failed).toEqual([
      { provider: 'a', code: 'FLIX_INTERNAL' },
      { provider: 'c', code: 'FLIX_UPSTREAM_TIMEOUT' },
    ]);
  });

  it('todos caídos → 503 FLIX_SOURCE_UNAVAILABLE', async () => {
    await expect(getPlayback('tmdb-movie-1', undefined, [failing('x1')], noImdb)).rejects.toMatchObject({ code: 'FLIX_SOURCE_UNAVAILABLE', status: 503 });
  });

  it('resuelve IMDb solo si algún proveedor lo necesita', async () => {
    const resolve = vi.fn(async () => 'tt0133093');
    await getPlayback('tmdb-movie-603', undefined, [ok('t1')], resolve);
    expect(resolve).not.toHaveBeenCalled();
    const r = await getPlayback('tmdb-movie-603', undefined, [ok('t2'), ok('i1', 'imdb')], resolve);
    expect(resolve).toHaveBeenCalledOnce();
    expect(r.sources[1].url).toBe('https://i1/tt0133093/');
  });

  it('proveedor IMDb sin id IMDb → falla solo ese', async () => {
    const r = await getPlayback('tmdb-movie-603', undefined, [ok('t3'), ok('i2', 'imdb')], noImdb);
    expect(r.failed).toEqual([{ provider: 'i2', code: 'FLIX_NOT_FOUND' }]);
  });

  it('serie sin episodio → 400', async () => {
    await expect(getPlayback('tmdb-tv-1399', undefined, [ok('t4')], noImdb)).rejects.toMatchObject({ code: 'FLIX_VALIDATION_ERROR' });
  });
});

describe('GET /flix/playback', () => {
  it('película → embed de 111movies', async () => {
    const { status, body, headers } = await get('/flix/playback/tmdb-movie-603');
    expect(status).toBe(200);
    expect(body).toEqual({ sources: [{ provider: '111movies', url: 'https://player.test/movie/603', kind: 'embed' }], failed: [] });
    expect(headers.get('cache-control')).toBe('private, max-age=600');
  });

  it('serie con episodio y base configurable', async () => {
    const { body } = await get('/flix/playback/tmdb-tv-1399?s=2&e=5', { PLAYER_BASE_URL: 'https://mirror.example/' });
    expect(body.sources[0].url).toBe('https://mirror.example/tv/1399/2/5');
  });

  it('s sin e → 400', async () => {
    const { status, body } = await get('/flix/playback/tmdb-tv-1399?s=2');
    expect(status).toBe(400);
    expect(body.error.code).toBe('FLIX_VALIDATION_ERROR');
  });

  it('/flix/health lista proveedores con su breaker', async () => {
    const { body } = await get('/flix/health');
    expect(body).toEqual({
      status: 'ok',
      providers: [
        { id: 'tmdb', kind: 'metadata', state: 'closed' },
        { id: '111movies', kind: 'stream', state: 'closed' },
      ],
    });
  });

  it('TMDB caído 3 veces → breaker abierto y /flix/health degraded', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status: 500 }));
    for (let i = 1; i <= 3; i++) expect((await get(`/flix/titles/tmdb-movie-${i}`)).body.error.code).toBe('FLIX_UPSTREAM_ERROR');
    expect((await get('/flix/titles/tmdb-movie-4')).body.error.code).toBe('FLIX_UPSTREAM_UNAVAILABLE');
    expect((await get('/flix/health')).body.status).toBe('degraded');
  });
});

describe('URLs de proveedores por entorno', () => {
  it('sin PLAYER_BASE_URL no hay fuentes → 503', async () => {
    const { status, body } = await get('/flix/playback/tmdb-movie-603', { PLAYER_BASE_URL: '' });
    expect(status).toBe(503);
    expect(body.error.code).toBe('FLIX_SOURCE_UNAVAILABLE');
  });

  it('sin TMDB_API_URL → 503 FLIX_NOT_CONFIGURED', async () => {
    const { status, body } = await get('/flix/titles/tmdb-movie-603', { TMDB_API_URL: '' });
    expect(status).toBe(503);
    expect(body.error.code).toBe('FLIX_NOT_CONFIGURED');
  });
});

describe('proveedores de embed por STREAM_PROVIDERS', () => {
  const extra = JSON.stringify([
    { id: 'alt', movie: 'https://alt.test/m/{tmdb}', tv: 'https://alt.test/t/{tmdb}/{s}/{e}' },
  ]);

  it('agrega las fuentes extra después de 111movies, en orden', async () => {
    const { body } = await get('/flix/playback/tmdb-tv-1399?s=2&e=5', { STREAM_PROVIDERS: extra });
    expect(body.sources.map((s: { provider: string; url: string }) => [s.provider, s.url])).toEqual([
      ['111movies', 'https://player.test/tv/1399/2/5'],
      ['alt', 'https://alt.test/t/1399/2/5'],
    ]);
  });

  it('plantilla con {imdb}: resuelve el id de IMDb con TMDB', async () => {
    const { createEmbedProvider } = await import('../src/modules/flix/providers/streams/embed');
    const p = createEmbedProvider({ id: 'imdbish', movie: 'https://x.test/{imdb}', tv: 'https://x.test/{imdb}/{s}x{e}' });
    expect(p.needs).toBe('imdb');
    expect(await p.getSources({ type: 'movie', tmdb: 603, imdb: 'tt0133093' })).toEqual([{ provider: 'imdbish', url: 'https://x.test/tt0133093', kind: 'embed' }]);
  });

  it('JSON inválido se ignora sin romper el playback', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { status, body } = await get('/flix/playback/tmdb-movie-603', { STREAM_PROVIDERS: '[{"id":"x"' });
    expect(status).toBe(200);
    expect(body.sources).toHaveLength(1);
  });

  it('/flix/health lista los proveedores extra', async () => {
    const { body } = await get('/flix/health', { STREAM_PROVIDERS: extra });
    expect(body.providers.map((p: { id: string }) => p.id)).toEqual(['tmdb', '111movies', 'alt']);
  });
});
