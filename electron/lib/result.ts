import type { Result } from '../../shared/types';

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function fail(error: unknown): Result<never> {
  return { ok: false, error: errorText(error) };
}

/** Оборачивает async-функцию так, чтобы ошибки возвращались как Result. */
export async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn());
  } catch (error) {
    return fail(error);
  }
}
