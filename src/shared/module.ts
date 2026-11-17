import { OpenAPIHono } from '@hono/zod-openapi';
import type { AppEnv } from '../env';
import { errorJson, onError } from './errors';

/** Sub-app de una vertical con su propio error boundary y errores de validación en la forma común. */
export function createModule(name: string) {
  const app = new OpenAPIHono<AppEnv>({
    defaultHook: (result, c) => {
      if (!result.success) return errorJson(c, name, 'VALIDATION_ERROR', 400, result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
    },
  });
  app.onError(onError(name));
  return app;
}

export const enabledModules = (env: AppEnv['Bindings']) =>
  (env.ENABLED_MODULES ?? '').split(',').map((m) => m.trim()).filter(Boolean);
