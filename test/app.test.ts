import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import app from '../src/index';
import { AppError } from '../src/shared/errors';
import { fetchJson } from '../src/shared/http';
import { createModule, enabledModules } from '../src/shared/module';

describe('app', () => {
  it('GET /health', async () => {
    const res = await app.request('/health', {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok', modules: ['auth', 'flix', 'miru'] });
  });

  it('GET /openapi.json documenta /health', async () => {
    const doc = await (await app.request('/openapi.json', {}, env)).json<{ openapi: string; paths: object }>();
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.paths).toHaveProperty('/health');
  });

  it('404 con la forma de error común', async () => {
    const res = await app.request('/nope', {}, env);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'APP_NOT_FOUND', message: 'Route not found', module: 'app' } });
  });

  it('ENABLED_MODULES se parsea con espacios y vacíos', () => {
    expect(enabledModules({ ENABLED_MODULES: ' auth, flix ,,' })).toEqual(['auth', 'flix']);
  });
});

describe('error boundary por módulo', () => {
  const mod = createModule('flix');
  mod.get('/app-error', () => {
    throw new AppError('flix', 'SOURCE_UNAVAILABLE', 503, 'down');
  });
  mod.get('/crash', () => {
    throw new Error('boom');
  });

  it('AppError conserva código y status', async () => {
    const res = await mod.request('/app-error');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'FLIX_SOURCE_UNAVAILABLE', message: 'down', module: 'flix' } });
  });

  it('error inesperado → 500 del módulo sin filtrar detalles', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await mod.request('/crash');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: { code: 'FLIX_INTERNAL', message: 'Internal error', module: 'flix' } });
  });
});

describe('fetchJson', () => {
  afterEach(() => vi.restoreAllMocks());

  it('devuelve el JSON en 2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ a: 1 }));
    expect(await fetchJson('https://x.test', { module: 'flix' })).toEqual({ a: 1 });
  });

  it.each([
    [404, 'FLIX_NOT_FOUND'],
    [500, 'FLIX_UPSTREAM_ERROR'],
  ])('status %i → %s', async (status, code) => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('x', { status }));
    await expect(fetchJson('https://x.test', { module: 'flix' })).rejects.toMatchObject({ code });
  });

  it('timeout → FLIX_UPSTREAM_TIMEOUT (504)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new DOMException('t', 'TimeoutError'));
    await expect(fetchJson('https://x.test', { module: 'flix' })).rejects.toMatchObject({ code: 'FLIX_UPSTREAM_TIMEOUT', status: 504 });
  });
});
