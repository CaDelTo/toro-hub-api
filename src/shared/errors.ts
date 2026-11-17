import { z } from '@hono/zod-openapi';
import type { Context, ErrorHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

/** Forma única de error para el front: `{ error: { code, message, module } }`. */
export const ErrorBody = z
  .object({ error: z.object({ code: z.string().openapi({ example: 'FLIX_UPSTREAM_TIMEOUT' }), message: z.string(), module: z.string() }) })
  .openapi('Error');
export type ErrorBody = z.infer<typeof ErrorBody>;

/** Respuestas de error para documentar en cada ruta de OpenAPI. */
export const errorResponses = Object.fromEntries(
  ([[400, 'Parámetros inválidos'], [404, 'No encontrado'], [502, 'Error del proveedor'], [503, 'Módulo sin configurar'], [504, 'Timeout del proveedor']] as const).map(
    ([status, description]) => [status, { description, content: { 'application/json': { schema: ErrorBody } } }],
  ),
) as Record<400 | 404 | 502 | 503 | 504, { description: string; content: { 'application/json': { schema: typeof ErrorBody } } }>;

export class AppError extends Error {
  readonly code: string;
  constructor(
    readonly module: string,
    code: string, // sin prefijo: 'UPSTREAM_TIMEOUT' → 'FLIX_UPSTREAM_TIMEOUT'
    readonly status: ContentfulStatusCode,
    message: string,
  ) {
    super(message);
    this.code = `${module.toUpperCase()}_${code}`;
  }
}

export const errorJson = (c: Context, module: string, code: string, status: ContentfulStatusCode, message: string) =>
  c.json<ErrorBody>({ error: { code: `${module.toUpperCase()}_${code}`, message, module } }, status);

/** Error boundary por módulo: cada vertical lo registra con su nombre. */
export const onError =
  (module: string): ErrorHandler =>
  (err, c) => {
    if (err instanceof AppError) return c.json<ErrorBody>({ error: { code: err.code, message: err.message, module: err.module } }, err.status);
    if (err instanceof HTTPException) return errorJson(c, module, 'HTTP_ERROR', err.status as ContentfulStatusCode, err.message);
    console.error(`[${module}]`, err);
    return errorJson(c, module, 'INTERNAL', 500, 'Internal error');
  };
