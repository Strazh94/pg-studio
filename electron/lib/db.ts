import { Pool } from 'pg';
import type { PoolClient } from 'pg';
import type {
  CancelInput,
  ColumnInfo,
  ConnectionConfig,
  InsertRowInput,
  DeleteRowInput,
  QueryInput,
  QueryResult,
  ReadTableInput,
  SchemaInfo,
  TableInfo,
  TablePage,
  TableRef,
  UpdateRowInput,
} from '../../shared/types';
import { getConnection, resolveConfig } from './connections';
import {
  MAX_ROWS,
  buildCount,
  buildDelete,
  buildInsert,
  buildSelectPage,
  buildUpdate,
  toJsonSafe,
} from './sql';

const pools = new Map<string, Pool>();
const runningQueries = new Map<string, PoolClient>();
const typeNamesCache = new Map<string, Map<number, string>>();

function poolConfig(config: ConnectionConfig) {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  };
}

function poolFor(connectionId: string): Pool {
  const existing = pools.get(connectionId);
  if (existing) return existing;
  const config = getConnection(connectionId);
  if (!config) {
    throw new Error('Сохранённое подключение не найдено. Откройте менеджер подключений.');
  }
  const pool = new Pool(poolConfig(config));
  // Ошибки «протухших» idle-соединений не должны ронять приложение.
  pool.on('error', () => undefined);
  pools.set(connectionId, pool);
  return pool;
}

export async function closePool(connectionId: string): Promise<void> {
  const pool = pools.get(connectionId);
  pools.delete(connectionId);
  typeNamesCache.delete(connectionId);
  if (pool) {
    try {
      await pool.end();
    } catch {
      // уже закрыт
    }
  }
}

export async function closeAllPools(): Promise<void> {
  await Promise.all([...pools.keys()].map((id) => closePool(id)));
}

/** Проверка реквизитов: возвращает, например, «PostgreSQL 16.2». */
export async function testConnection(config: ConnectionConfig): Promise<string> {
  const resolved = resolveConfig(config);
  const pool = new Pool({ ...poolConfig(resolved), max: 1 });
  try {
    const res = await pool.query('SELECT version()');
    const version = String(res.rows[0]?.version ?? 'ok');
    const parts = version.split(' ');
    return parts.length >= 2 ? `${parts[0]} ${parts[1]}` : version;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function typeNames(pool: Pool, connectionId: string): Promise<Map<number, string>> {
  const cached = typeNamesCache.get(connectionId);
  if (cached) return cached;
  const res = await pool.query('SELECT oid, format_type(oid, NULL) AS name FROM pg_type');
  const map = new Map<number, string>();
  for (const row of res.rows as Array<{ oid: string; name: string }>) {
    map.set(Number(row.oid), row.name);
  }
  typeNamesCache.set(connectionId, map);
  return map;
}

/**
 * Выполняет произвольный SQL. queryId генерируется рендером заранее,
 * чтобы уже во время выполнения можно было отменить запрос.
 */
export async function runQuery(input: QueryInput): Promise<QueryResult> {
  const pool = poolFor(input.connectionId);
  const client = await pool.connect();
  runningQueries.set(input.queryId, client);
  const started = Date.now();
  try {
    const res = await client.query({ text: input.sql, rowMode: 'array' });
    const names = await typeNames(pool, input.connectionId);
    const fields = res.fields ?? [];
    const columns = fields.map((field) => ({
      name: field.name,
      type: names.get(field.dataTypeID) ?? '',
    }));
    const allRows = (res.rows ?? []) as unknown[][];
    const truncated = allRows.length > MAX_ROWS;
    const rows = (truncated ? allRows.slice(0, MAX_ROWS) : allRows).map((row) =>
      row.map(toJsonSafe),
    );
    return {
      columns,
      rows,
      rowCount: res.rowCount,
      truncated,
      durationMs: Date.now() - started,
    };
  } finally {
    runningQueries.delete(input.queryId);
    client.release();
  }
}

/** Отмена выполняющегося запроса через pg_cancel_backend отдельным соединением. */
export async function cancelQuery(input: CancelInput): Promise<boolean> {
  const client = runningQueries.get(input.queryId);
  if (!client) return false;
  // processID — pid бэкенда в pg; в @types/pg поле объявлено только у Client.
  const pid = (client as unknown as { processID?: number }).processID;
  if (pid == null) return false;
  const pool = poolFor(input.connectionId);
  await pool.query('SELECT pg_cancel_backend($1)', [pid]);
  return true;
}

export async function getSchemas(connectionId: string): Promise<SchemaInfo[]> {
  const pool = poolFor(connectionId);
  const res = await pool.query(
    `SELECT nspname AS name
       FROM pg_namespace
      WHERE nspname <> 'information_schema'
        AND nspname NOT LIKE 'pg\\_%'
      ORDER BY nspname`,
  );
  return (res.rows as Array<{ name: string }>).map((row) => ({ name: row.name }));
}

const KIND_MAP: Record<string, TableInfo['kind']> = {
  r: 'table',
  p: 'partitioned',
  v: 'view',
  m: 'materialized',
  f: 'foreign',
};

export async function getTables(connectionId: string): Promise<TableInfo[]> {
  const pool = poolFor(connectionId);
  const res = await pool.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind AS kind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname <> 'information_schema'
        AND n.nspname NOT LIKE 'pg\\_%'
        AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
      ORDER BY n.nspname, CASE WHEN c.relkind IN ('r', 'p') THEN 0 ELSE 1 END, c.relname`,
  );
  return (res.rows as Array<{ schema: string; name: string; kind: string }>).map((row) => ({
    schema: row.schema,
    name: row.name,
    kind: KIND_MAP[row.kind] ?? 'table',
  }));
}

const COLUMN_SQL = `
  SELECT a.attname AS name,
         format_type(a.atttypid, a.atttypmod) AS type,
         NOT a.attnotnull AS nullable,
         pg_get_expr(ad.adbin, ad.adrelid) AS default_value,
         EXISTS (
           SELECT 1
             FROM pg_index i
            WHERE i.indrelid = a.attrelid
              AND i.indisprimary
              AND a.attnum = ANY (i.indkey)
         ) AS pk
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace ns ON ns.oid = c.relnamespace
    LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
   WHERE ns.nspname = $1
     AND c.relname = $2
     AND a.attnum > 0
     AND NOT a.attisdropped
   ORDER BY a.attnum`;

export async function getColumnsFor(input: TableRef): Promise<ColumnInfo[]> {
  const pool = poolFor(input.connectionId);
  const res = await pool.query(COLUMN_SQL, [input.schema, input.name]);
  return (res.rows as RawColumn[]).map(toColumnInfo);
}

interface RawColumn {
  name: string;
  type: string;
  nullable: boolean;
  default_value: string | null;
  pk: boolean;
}

function toColumnInfo(row: RawColumn): ColumnInfo {
  return {
    name: row.name,
    type: row.type,
    nullable: Boolean(row.nullable),
    defaultValue: row.default_value ?? null,
    primaryKey: Boolean(row.pk),
  };
}

async function columnsOf(pool: Pool, schema: string, table: string): Promise<ColumnInfo[]> {
  const res = await pool.query(COLUMN_SQL, [schema, table]);
  if (res.rowCount === 0) {
    throw new Error(`Объект «${schema}.${table}» не найден или недоступен для чтения`);
  }
  return (res.rows as RawColumn[]).map(toColumnInfo);
}

function assertRowShape(columns: ColumnInfo[], ...valueSets: unknown[][]): void {
  for (const values of valueSets) {
    if (values.length !== columns.length) {
      throw new Error(
        `Строкa данных не совпадает со структурой таблицы (получено ${values.length}, ожидалось ${columns.length}). Обновите вкладку.`,
      );
    }
  }
}

export async function readTable(input: ReadTableInput): Promise<TablePage> {
  const started = Date.now();
  const pool = poolFor(input.connectionId);
  const columns = await columnsOf(pool, input.schema, input.name);
  const select = buildSelectPage(input.schema, input.name, columns, input.limit, input.offset);
  const [countRes, pageRes] = await Promise.all([
    pool.query(buildCount(input.schema, input.name)),
    pool.query({ text: select.sql, values: select.params, rowMode: 'array' }),
  ]);
  const total = Number(countRes.rows[0]?.total ?? 0);
  const rows = ((pageRes.rows ?? []) as unknown[][]).map((row) => row.map(toJsonSafe));
  return {
    columns,
    rows,
    total,
    rowCount: pageRes.rowCount,
    truncated: false,
    durationMs: Date.now() - started,
  };
}

export async function insertRow(input: InsertRowInput): Promise<number> {
  const pool = poolFor(input.connectionId);
  const columns = await columnsOf(pool, input.schema, input.name);
  assertRowShape(columns, input.values, input.useDefault);
  if (input.values.length !== input.useDefault.length) {
    throw new Error('Некорректные данные формы добавления строки');
  }
  const statement = buildInsert(
    input.schema,
    input.name,
    columns,
    input.values,
    input.useDefault,
  );
  const res = await pool.query(statement.sql, statement.params);
  return res.rowCount ?? 0;
}

export async function updateRow(input: UpdateRowInput): Promise<number> {
  const pool = poolFor(input.connectionId);
  const columns = await columnsOf(pool, input.schema, input.name);
  assertRowShape(columns, input.original, input.next);
  const statement = buildUpdate(input.schema, input.name, columns, input.original, input.next);
  if (!statement) return 0; // ничего не изменилось
  const res = await pool.query(statement.sql, statement.params);
  return res.rowCount ?? 0;
}

export async function deleteRow(input: DeleteRowInput): Promise<number> {
  const pool = poolFor(input.connectionId);
  const columns = await columnsOf(pool, input.schema, input.name);
  assertRowShape(columns, input.original);
  const statement = buildDelete(input.schema, input.name, columns, input.original);
  const res = await pool.query(statement.sql, statement.params);
  return res.rowCount ?? 0;
}
