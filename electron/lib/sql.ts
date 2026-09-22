/**
 * Чистые функции построения SQL и сериализации значений.
 * Здесь нет зависимостей от Electron и pg — этот модуль покрыт тестами.
 */

/** Максимум строк, возвращаемых в рендер (защита от «взорвавшейся» выборки). */
export const MAX_ROWS = 2000;

export function quoteIdent(name: string): string {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

export function qualified(schema: string, table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

/**
 * Приводит значение из pg к виду, безопасному для JSON (для IPC).
 * bytea → строка в формате `\x..` (корректно ложится обратно в bytea-параметр),
 * даты → ISO-строки, bigint → строка.
 */
export function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Buffer.isBuffer(value)) return '\\x' + value.toString('hex');
  if (value instanceof Uint8Array) return '\\x' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toJsonSafe(val);
    }
    return out;
  }
  return value;
}

/** Сравнение значений, пришедших из JSON (null !== undefined). */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

interface WherePair {
  name: string;
  value: unknown;
}

/**
 * `col IS NOT DISTINCT FROM $n` — корректно работает и для NULL,
 * и для любого типа (PostgreSQL приводит параметр к типу столбца).
 */
export function buildWhere(pairs: WherePair[], startAt: number): { sql: string; params: unknown[] } {
  const sql = pairs
    .map((pair, index) => `${quoteIdent(pair.name)} IS NOT DISTINCT FROM $${startAt + index}`)
    .join(' AND ');
  return { sql, params: pairs.map((pair) => pair.value) };
}

/** Ключевые столбцы для поиска строки: PK, либо (если PK нет) все столбцы. */
export function keyPairsFor(
  columns: { name: string; primaryKey: boolean }[],
  row: unknown[],
): WherePair[] {
  const keys = columns.filter((column) => column.primaryKey);
  const source = keys.length > 0 ? keys : columns;
  return source.map((column) => ({
    name: column.name,
    value: row[columns.indexOf(column)],
  }));
}

export function buildSelectPage(
  schema: string,
  table: string,
  columns: { name: string; primaryKey: boolean }[],
  limit: number,
  offset: number,
): { sql: string; params: unknown[] } {
  const keys = columns.filter((column) => column.primaryKey).map((column) => column.name);
  const order = (keys.length > 0 ? keys : ['ctid']).map(quoteIdent).join(', ');
  return {
    sql: `SELECT * FROM ${qualified(schema, table)} ORDER BY ${order} LIMIT $1 OFFSET $2`,
    params: [limit, offset],
  };
}

export function buildCount(schema: string, table: string): string {
  return `SELECT count(*)::bigint AS total FROM ${qualified(schema, table)}`;
}

export interface UpdateStatement {
  sql: string;
  params: unknown[];
}

/** Обновляет только реально изменившиеся столбцы. null — если изменений нет. */
export function buildUpdate(
  schema: string,
  table: string,
  columns: { name: string; primaryKey: boolean }[],
  original: unknown[],
  next: unknown[],
): UpdateStatement | null {
  const changed: number[] = [];
  columns.forEach((_, index) => {
    if (!sameValue(original[index], next[index])) changed.push(index);
  });
  if (changed.length === 0) return null;

  const setSql = changed
    .map((index, position) => `${quoteIdent(columns[index].name)} = $${position + 1}`)
    .join(', ');
  const where = buildWhere(keyPairsFor(columns, original), changed.length + 1);
  return {
    sql: `UPDATE ${qualified(schema, table)} SET ${setSql} WHERE ${where.sql}`,
    params: [...changed.map((index) => next[index]), ...where.params],
  };
}

export function buildDelete(
  schema: string,
  table: string,
  columns: { name: string; primaryKey: boolean }[],
  original: unknown[],
): UpdateStatement {
  const where = buildWhere(keyPairsFor(columns, original), 1);
  return {
    sql: `DELETE FROM ${qualified(schema, table)} WHERE ${where.sql}`,
    params: where.params,
  };
}

export function buildInsert(
  schema: string,
  table: string,
  columns: { name: string }[],
  values: unknown[],
  useDefault: boolean[],
): UpdateStatement {
  const used = columns
    .map((_, index) => index)
    .filter((index) => useDefault[index] !== true);

  if (used.length === 0) {
    return { sql: `INSERT INTO ${qualified(schema, table)} DEFAULT VALUES`, params: [] };
  }
  const colSql = used.map((index) => quoteIdent(columns[index].name)).join(', ');
  const valSql = used.map((_, position) => `$${position + 1}`).join(', ');
  return {
    sql: `INSERT INTO ${qualified(schema, table)} (${colSql}) VALUES (${valSql})`,
    params: used.map((index) => values[index]),
  };
}
