import type { PgStudioApi, Result } from '../shared/types';

export const api: PgStudioApi = window.api;

export function unwrap<T>(result: Result<T>): T {
  if (result.ok) return result.value;
  throw new Error(result.error);
}

/** Короткий уникальный id (без зависимости от crypto.randomUUID в file://). */
export function uid(): string {
  return `q${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}
