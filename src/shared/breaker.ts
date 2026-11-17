import { AppError } from './errors';

/**
 * Circuit breaker por adapter, en memoria del isolate.
 * shortcut: cada isolate tiene su propio estado (no se comparte entre datacenters ni réplicas); suficiente
 * porque el timeout es la protección principal. Pasar a Durable Object si hace falta un estado global.
 */
type State = { failures: number; openUntil: number };
const states = new Map<string, State>();

const THRESHOLD = 3;
const COOLDOWN_MS = 30_000;

/** Un 4xx del proveedor (p. ej. 404) es una respuesta válida, no una caída. */
const isOutage = (err: unknown) => !(err instanceof AppError && err.status < 500);

export async function withBreaker<T>(key: string, module: string, fn: () => Promise<T>): Promise<T> {
  const s = states.get(key) ?? { failures: 0, openUntil: 0 };
  if (Date.now() < s.openUntil) throw new AppError(module, 'UPSTREAM_UNAVAILABLE', 503, `${key} is temporarily disabled after repeated failures`);
  try {
    const result = await fn();
    states.delete(key);
    return result;
  } catch (err) {
    if (isOutage(err) && ++s.failures >= THRESHOLD) {
      s.openUntil = Date.now() + COOLDOWN_MS;
      s.failures = THRESHOLD - 1; // half-open: tras el cooldown, un solo fallo lo vuelve a abrir
    }
    states.set(key, s);
    throw err;
  }
}

export const breakerState = (key: string): 'open' | 'closed' => (Date.now() < (states.get(key)?.openUntil ?? 0) ? 'open' : 'closed');
