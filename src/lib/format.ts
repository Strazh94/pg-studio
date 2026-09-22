/** Отображение значений ячеек в сетках. */

export const MAX_CELL_LENGTH = 400;

export function isNullish(value: unknown): boolean {
  return value === null || value === undefined;
}

export function displayCell(value: unknown): string {
  if (isNullish(value)) return 'NULL';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return formatPgArray(value);
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Массивы pg показываем в «родном» литерале: {1,2,3}. */
function formatPgArray(value: unknown[]): string {
  const parts = value.map((item) => {
    if (isNullish(item)) return 'NULL';
    if (typeof item === 'string') return item.includes(',') || item.includes('"')
      ? `"${item.replace(/"/g, '\\"')}"`
      : item;
    if (Array.isArray(item)) return formatPgArray(item);
    return displayCell(item);
  });
  return `{${parts.join(',')}}`;
}

export function shortText(text: string, limit = MAX_CELL_LENGTH): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

export function pluralRows(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} строка`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} строки`;
  return `${n} строк`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(2)} с`;
}
