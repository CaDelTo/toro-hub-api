import { createRoute, OpenAPIHono, z } from '@hono/zod-openapi';
import { logger } from 'hono/logger';
import type { AppEnv } from './env';
import auth from './modules/auth/routes';
import flix from './modules/flix/routes';
import { errorJson } from './shared/errors';
import { createModule, enabledModules } from './shared/module';
import { requireSession } from './shared/session';

// Módulos de vertical. Nunca se importan entre sí.
const modules: Record<string, OpenAPIHono<AppEnv>> = { auth, flix };
const PUBLIC_MODULES = new Set(['auth']);

const app = createModule('app');
app.use(logger());
app.notFound((c) => errorJson(c, 'app', 'NOT_FOUND', 404, 'Route not found'));

for (const [name, mod] of Object.entries(modules)) {
  app.use(`/${name}/*`, async (c, next) => {
    if (!enabledModules(c.env).includes(name)) return c.notFound();
    await next();
  });
  // Antes de app.route: corre antes que el cache del módulo, así nunca se sirve una respuesta cacheada sin sesión.
  if (!PUBLIC_MODULES.has(name)) app.use(`/${name}/*`, requireSession(name));
  app.route(`/${name}`, mod);
}

app.openapi(
  createRoute({
    method: 'get',
    path: '/health',
    tags: ['app'],
    responses: {
      200: {
        description: 'Servicio vivo y módulos montados',
        content: { 'application/json': { schema: z.object({ status: z.literal('ok'), modules: z.array(z.string()) }) } },
      },
    },
  }),
  (c) => c.json({ status: 'ok' as const, modules: enabledModules(c.env).filter((m) => m in modules) }, 200),
);

app.doc31('/openapi.json', { openapi: '3.1.0', info: { title: 'toro-hub-api', version: '0.1.0' } });

export default app;
