import type { z } from 'zod';
import { AppError } from '../errors.js';

export function parseBody<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const result = schema.safeParse(body ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new AppError('validation_error', issues[0]?.message ?? 'Invalid request.', { details: issues });
  }
  return result.data;
}
