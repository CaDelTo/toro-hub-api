import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { verify } from 'hono/jwt';
import type { AppEnv, Bindings } from '../env';
import { errorJson } from './errors';

/** Cookie de sesión compartida por todos los subdominios (Domain=COOKIE_DOMAIN). El proxy.ts del front valida el mismo JWT. */
export const SESSION_COOKIE = 'th_session';

/** Sin SITE_PASSWORD el sitio es público, igual que el front hoy. */
export const authRequired = (env: Bindings) => Boolean(env.SITE_PASSWORD);

/** exp (segundos epoch) si la cookie trae un JWT válido y vigente; null si no. */
export async function readSession(c: Context<AppEnv>): Promise<number | null> {
  const token = getCookie(c, SESSION_COOKIE);
  if (!token || !c.env.JWT_SECRET) return null;
  try {
    const payload = await verify(token, c.env.JWT_SECRET, 'HS256');
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null; // firma inválida, expirado o malformado
  }
}

/** Exige sesión en las rutas de una vertical. Registrar ANTES del cache del módulo. */
export const requireSession =
  (module: string): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    if (!authRequired(c.env)) return next();
    if (!c.env.JWT_SECRET) return errorJson(c, 'auth', 'NOT_CONFIGURED', 503, 'JWT_SECRET is not set');
    if ((await readSession(c)) === null) return errorJson(c, module, 'UNAUTHORIZED', 401, 'Session required');
    await next();
  };
