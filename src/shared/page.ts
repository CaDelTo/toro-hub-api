import { z } from '@hono/zod-openapi';

/** Paginación común a todas las verticales. */
export const pageSchema = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    page: z.number().int(),
    totalPages: z.number().int(),
    totalResults: z.number().int(),
  });
