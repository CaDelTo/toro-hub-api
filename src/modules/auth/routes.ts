import { createRoute, z } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { deleteCookie, setCookie } from 'hono/cookie';
import { sign } from 'hono/jwt';
import type { CookieOptions } from 'hono/utils/cookie';
import type { AppEnv } from '../../env';
import { AppError, errorResponses } from '../../shared/errors';
import { createModule } from '../../shared/module';
import { authRequired, readSession, SESSION_COOKIE } from '../../shared/session';

const SESSION_SECONDS = 30 * 24 * 3600;

const Session = z
  .object({
    authenticated: z.boolean(),
    required: z.boolean().openapi({ description: 'false si el sitio no tiene contraseña configurada' }),
    exp: z.number().int().nullable().openapi({ description: 'Expiración de la sesión (segundos epoch)' }),
  })
  .openapi('AuthSession');

const ok = { description: 'OK', content: { 'application/json': { schema: Session } } };

const cookieOptions = (c: Context<AppEnv>, maxAge: number): CookieOptions => ({
  httpOnly: true,
  secure: new URL(c.req.url).protocol === 'https:',
  sameSite: 'Lax',
  path: '/',
  domain: c.env.COOKIE_DOMAIN || undefined,
  maxAge,
});

/** Comparación en tiempo constante (hash previo para igualar longitudes). */
async function sameSecret(a: string, b: string) {
  const digest = (s: string) => crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

const auth = createModule('auth');

auth.use('*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'no-store');
});

auth.openapi(
  createRoute({
    method: 'post',
    path: '/login',
    tags: ['auth'],
    summary: 'Inicia sesión con la contraseña del sitio y emite la cookie th_session',
    request: { body: { required: true, content: { 'application/json': { schema: z.object({ password: z.string().min(1).max(200) }) } } } },
    responses: { 200: ok, 401: { ...errorResponses[400], description: 'Contraseña incorrecta' }, 400: errorResponses[400], 503: errorResponses[503] },
  }),
  async (c) => {
    const { SITE_PASSWORD, JWT_SECRET } = c.env;
    if (!SITE_PASSWORD || !JWT_SECRET) throw new AppError('auth', 'NOT_CONFIGURED', 503, 'Authentication is not configured');
    if (!(await sameSecret(c.req.valid('json').password, SITE_PASSWORD))) {
      // shortcut: retraso fijo contra fuerza bruta, sin contador por IP; añadir rate limiting si el sitio se expone más.
      await new Promise((r) => setTimeout(r, 500));
      throw new AppError('auth', 'INVALID_PASSWORD', 401, 'Incorrect password');
    }
    const now = Math.floor(Date.now() / 1000);
    const exp = now + SESSION_SECONDS;
    setCookie(c, SESSION_COOKIE, await sign({ sub: 'site', iat: now, exp }, JWT_SECRET, 'HS256'), cookieOptions(c, SESSION_SECONDS));
    return c.json({ authenticated: true, required: true, exp }, 200);
  },
);

auth.openapi(
  createRoute({ method: 'post', path: '/logout', tags: ['auth'], summary: 'Cierra la sesión (borra la cookie)', responses: { 200: ok } }),
  (c) => {
    deleteCookie(c, SESSION_COOKIE, cookieOptions(c, 0));
    return c.json({ authenticated: false, required: authRequired(c.env), exp: null }, 200);
  },
);

auth.openapi(
  createRoute({ method: 'get', path: '/session', tags: ['auth'], summary: 'Estado de la sesión actual', responses: { 200: ok } }),
  async (c) => {
    if (!authRequired(c.env)) return c.json({ authenticated: true, required: false, exp: null }, 200);
    const exp = await readSession(c);
    return c.json({ authenticated: exp !== null, required: true, exp }, 200);
  },
);

export default auth;
