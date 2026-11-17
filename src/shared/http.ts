import { AppError } from './errors';

type FetchJsonOptions = {
  module: string;
  timeoutMs?: number;
  /** Segundos que Cloudflare cachea la respuesta del proveedor (solo 2xx). */
  cacheTtl?: number;
  headers?: HeadersInit;
};

/** Rechaza con UPSTREAM_TIMEOUT si `p` no termina en `ms` (para adapters que no usan fetchJson). */
export function withTimeout<T>(p: Promise<T>, ms: number, module: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AppError(module, 'UPSTREAM_TIMEOUT', 504, `Upstream timed out after ${ms}ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** GET a un proveedor externo con timeout; los fallos salen como AppError del módulo. */
export async function fetchJson<T>(url: string | URL, { module, timeoutMs = 5000, cacheTtl, headers }: FetchJsonOptions): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cf: cacheTtl ? { cacheTtl, cacheEverything: true } : undefined,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') throw new AppError(module, 'UPSTREAM_TIMEOUT', 504, `Upstream timed out after ${timeoutMs}ms`);
    throw new AppError(module, 'UPSTREAM_UNREACHABLE', 502, 'Upstream unreachable');
  }
  if (res.status === 404) throw new AppError(module, 'NOT_FOUND', 404, 'Not found upstream');
  if (!res.ok) throw new AppError(module, 'UPSTREAM_ERROR', 502, `Upstream responded ${res.status}`);
  return res.json<T>();
}
