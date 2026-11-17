import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { sign } from 'hono/jwt';
import { describe, expect, it } from 'vitest';
import app from '../src/index';

const SECURE_ENV = { SITE_PASSWORD: 'toro', JWT_SECRET: 'secret', TMDB_API_KEY: 'k', COOKIE_DOMAIN: '.toro-hub.x' };

async function call(path: string, init: RequestInit = {}, extraEnv: Record<string, unknown> = SECURE_ENV, base = 'https://api.toro-hub.x') {
  const ctx = createExecutionContext();
  const res = await app.request(base + path, init, { ...env, ...extraEnv }, ctx);
  await waitOnExecutionContext(ctx);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

const login = (password: string, extraEnv?: Record<string, unknown>, base?: string) =>
  call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) }, extraEnv, base);

const withCookie = (token: string): RequestInit => ({ headers: { cookie: `th_session=${token}` } });
const tokenFrom = (setCookie: string | null) => /th_session=([^;]+)/.exec(setCookie ?? '')![1];

describe('auth', () => {
  it('contraseña incorrecta → 401 sin cookie', async () => {
    const { status, body, headers } = await login('nope');
    expect(status).toBe(401);
    expect(body.error.code).toBe('AUTH_INVALID_PASSWORD');
    expect(headers.get('set-cookie')).toBeNull();
  });

  it('login correcto emite cookie compartida, HttpOnly, Secure y con expiración', async () => {
    const before = Math.floor(Date.now() / 1000);
    const { status, body, headers } = await login('toro');
    expect(status).toBe(200);
    expect(body.authenticated).toBe(true);
    expect(body.exp).toBeGreaterThanOrEqual(before + 30 * 24 * 3600);
    const cookie = headers.get('set-cookie')!;
    expect(cookie).toMatch(/^th_session=ey/);
    for (const attr of ['Max-Age=2592000', 'Domain=.toro-hub.x', 'Path=/', 'HttpOnly', 'Secure', 'SameSite=Lax']) expect(cookie).toContain(attr);
    expect(headers.get('cache-control')).toBe('no-store');
  });

  it('en local (http, sin COOKIE_DOMAIN) la cookie no lleva Secure ni Domain', async () => {
    const { headers } = await login('toro', { ...SECURE_ENV, COOKIE_DOMAIN: '' }, 'http://localhost:8787');
    const cookie = headers.get('set-cookie')!;
    expect(cookie).not.toContain('Secure');
    expect(cookie).not.toContain('Domain');
  });

  it('body inválido → 400 AUTH_VALIDATION_ERROR', async () => {
    const { status, body } = await call('/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(status).toBe(400);
    expect(body.error.code).toBe('AUTH_VALIDATION_ERROR');
  });

  it('/auth/session refleja la cookie', async () => {
    const token = tokenFrom((await login('toro')).headers.get('set-cookie'));
    expect((await call('/auth/session')).body).toEqual({ authenticated: false, required: true, exp: null });
    expect((await call('/auth/session', withCookie(token))).body).toMatchObject({ authenticated: true, required: true });
  });

  it('logout borra la cookie', async () => {
    const { headers } = await call('/auth/logout', { method: 'POST' });
    expect(headers.get('set-cookie')).toMatch(/th_session=;.*Max-Age=0/);
  });
});

describe('sesión en las verticales', () => {
  it('sin cookie → 401 con código del módulo; con cookie → 200', async () => {
    const { status, body } = await call('/flix/genres');
    expect(status).toBe(401);
    expect(body.error.code).toBe('FLIX_UNAUTHORIZED');

    const token = tokenFrom((await login('toro')).headers.get('set-cookie'));
    expect((await call('/flix/genres', withCookie(token))).status).toBe(200);
  });

  it('una respuesta ya cacheada no se sirve sin sesión', async () => {
    const token = tokenFrom((await login('toro')).headers.get('set-cookie'));
    expect((await call('/flix/genres?c=1', withCookie(token))).status).toBe(200); // queda en cache
    expect((await call('/flix/genres?c=1')).status).toBe(401);
  });

  it('token expirado o firmado con otro secreto → 401', async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await sign({ sub: 'site', exp: now - 10 }, 'secret', 'HS256');
    const forged = await sign({ sub: 'site', exp: now + 3600 }, 'otro', 'HS256');
    expect((await call('/flix/genres', withCookie(expired))).status).toBe(401);
    expect((await call('/flix/genres', withCookie(forged))).status).toBe(401);
  });

  it('sin SITE_PASSWORD el sitio es público', async () => {
    const open = { TMDB_API_KEY: 'k', SITE_PASSWORD: '' };
    expect((await call('/flix/genres', {}, open)).status).toBe(200);
    expect((await call('/auth/session', {}, open)).body).toEqual({ authenticated: true, required: false, exp: null });
  });

  it('SITE_PASSWORD sin JWT_SECRET → 503 en login y en verticales', async () => {
    const broken = { SITE_PASSWORD: 'toro', TMDB_API_KEY: 'k' };
    expect((await login('toro', broken)).body.error.code).toBe('AUTH_NOT_CONFIGURED');
    expect((await call('/flix/genres', {}, broken)).status).toBe(503);
  });

  it('/health y /openapi.json siguen públicos', async () => {
    expect((await call('/health')).status).toBe(200);
    expect(Object.keys((await call('/openapi.json')).body.paths)).toContain('/auth/login');
  });
});
