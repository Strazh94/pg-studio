/**
 * Интеграционный тест main-процесса против настоящего PostgreSQL.
 * Запускается только при PG_STUDIO_IT=1 (см. README / CI workflow).
 */
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as connections from './connections';
import * as db from './db';

vi.mock('electron', () => ({
  app: {
    getPath: (_name: string) => path.join(os.tmpdir(), 'pgstudio-it'),
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value, 'utf8'),
    decryptString: (value: Buffer) => value.toString('utf8'),
  },
}));

const enabled = process.env.PG_STUDIO_IT === '1';

const host = process.env.PG_STUDIO_IT_HOST ?? 'localhost';
const port = Number(process.env.PG_STUDIO_IT_PORT ?? 5432);
const user = process.env.PG_STUDIO_IT_USER ?? 'postgres';
const password = process.env.PG_STUDIO_IT_PASSWORD ?? 'postgres';
const database = process.env.PG_STUDIO_IT_DB ?? 'postgres';

describe.runIf(enabled)('интеграция с PostgreSQL', () => {
  const connectionId = 'it-connection';
  const schema = 'public';
  const table = 'pg_studio_it';

  beforeAll(async () => {
    connections.saveConnection({
      id: connectionId,
      name: 'integration',
      host,
      port,
      database,
      user,
      password,
      ssl: false,
    });

    await db.runQuery({
      connectionId,
      queryId: 'setup-1',
      sql: `DROP TABLE IF EXISTS ${schema}.${table};
            CREATE TABLE ${schema}.${table} (
              id serial PRIMARY KEY,
              name text,
              amount integer DEFAULT 42,
              payload jsonb,
              created_at timestamptz NOT NULL DEFAULT now()
            );`,
    });
  }, 60_000);

  afterAll(async () => {
    await db
      .runQuery({
        connectionId,
        queryId: 'teardown-1',
        sql: `DROP TABLE IF EXISTS ${schema}.${table};`,
      })
      .catch(() => undefined);
    await db.closeAllPools().catch(() => undefined);
  });

  it('проверка подключения возвращает версию', async () => {
    const version = await db.testConnection({
      id: connectionId,
      name: 'integration',
      host,
      port,
      database,
      user,
      password,
      ssl: false,
    });
    expect(version).toMatch(/PostgreSQL/i);
  });

  it('читает схемы и таблицы', async () => {
    const schemas = await db.getSchemas(connectionId);
    expect(schemas.map((item) => item.name)).toContain('public');

    const tables = await db.getTables(connectionId);
    expect(tables).toEqual(
      expect.arrayContaining([{ schema, name: table, kind: 'table' }]),
    );
  });

  it('определяет структуру таблицы: типы, PK, default, NOT NULL', async () => {
    const columns = await db.getColumnsFor({ connectionId, schema, name: table });
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'name',
      'amount',
      'payload',
      'created_at',
    ]);
    expect(columns[0]).toMatchObject({ primaryKey: true, nullable: false });
    expect(columns[1]).toMatchObject({ type: 'text', nullable: true });
    expect(columns[2].defaultValue).toContain('42');
    expect(columns[4]).toMatchObject({ nullable: false });
  });

  it('полный CRUD через сетку (вставка, чтение, обновление, удаление)', async () => {
    const insert = await db.insertRow({
      connectionId,
      schema,
      name: table,
      values: ['', 'иван', '7', { hello: 'world' }, ''],
      useDefault: [true, false, false, false, true],
    });
    expect(insert).toBe(1);

    const page = await db.readTable({ connectionId, schema, name: table, offset: 0, limit: 50 });
    expect(page.total).toBe(1);
    expect(page.rows).toHaveLength(1);
    const [idCol, nameCol, amountCol, payloadCol] = page.columns;
    expect(page.rows[0][page.columns.indexOf(nameCol)]).toBe('иван');
    expect(page.rows[0][page.columns.indexOf(amountCol)]).toBe(7);
    expect(page.rows[0][page.columns.indexOf(payloadCol)]).toEqual({ hello: 'world' });

    // Обновление: меняем только name, amount должен сохраниться (42 из default тут не участвует)
    const original = [...page.rows[0]];
    const next = [...page.rows[0]];
    const nameIndex = page.columns.findIndex((column) => column.name === 'name');
    next[nameIndex] = 'пётр';
    const updated = await db.updateRow({ connectionId, schema, name: table, original, next });
    expect(updated).toBe(1);

    const after = await db.readTable({ connectionId, schema, name: table, offset: 0, limit: 50 });
    expect(after.rows[0][nameIndex]).toBe('пётр');

    // Без изменений — 0 обновлённых строк
    const noop = await db.updateRow({
      connectionId,
      schema,
      name: table,
      original: after.rows[0],
      next: after.rows[0],
    });
    expect(noop).toBe(0);

    const deleted = await db.deleteRow({
      connectionId,
      schema,
      name: table,
      original: after.rows[0],
    });
    expect(deleted).toBe(1);

    const empty = await db.readTable({ connectionId, schema, name: table, offset: 0, limit: 50 });
    expect(empty.total).toBe(0);
    expect(idCol).toBeDefined();
  });

  it('NULL действительно удаляется из ячейки', async () => {
    await db.runQuery({
      connectionId,
      queryId: 'it-null-1',
      sql: `INSERT INTO ${schema}.${table} (name, amount) VALUES ('null-test', 1)`,
    });
    const page = await db.readTable({ connectionId, schema, name: table, offset: 0, limit: 50 });
    const nameIndex = page.columns.findIndex((column) => column.name === 'name');
    const original = [...page.rows[0]];
    const next = [...page.rows[0]];
    next[nameIndex] = null;
    const updated = await db.updateRow({ connectionId, schema, name: table, original, next });
    expect(updated).toBe(1);

    const after = await db.readTable({ connectionId, schema, name: table, offset: 0, limit: 50 });
    expect(after.rows[0][nameIndex]).toBeNull();
    await db.deleteRow({ connectionId, schema, name: table, original: after.rows[0] });
  });

  it('ad-hoc запрос: типы столбцов и ограничение строк', async () => {
    const res = await db.runQuery({
      connectionId,
      queryId: 'it-q-1',
      sql: 'SELECT 1::int AS one, now() AS ts, NULL::text AS nothing',
    });
    expect(res.columns.map((column) => column.name)).toEqual(['one', 'ts', 'nothing']);
    expect(res.columns[0].type).toBe('integer');
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0][0]).toBe(1);
    expect(typeof res.rows[0][1]).toBe('string'); // дата сериализована в ISO
    expect(res.rows[0][2]).toBeNull();
    expect(res.truncated).toBe(false);
  });

  it('отмена длинного запроса через pg_cancel_backend', async () => {
    const queryId = 'it-cancel-1';
    const running = db.runQuery({
      connectionId,
      queryId,
      sql: 'SELECT pg_sleep(20)',
    });
    // Обработчик вешаем сразу же: отклонение может прийти раньше, чем мы
    // дождёмся старта на сервере, иначе поймаем unhandled rejection.
    const outcome = running.then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );

    // Ждём, пока запрос реально начнёт выполняться на сервере,
    // вместо фиксированной паузы (в CI тайминги другие).
    const deadline = Date.now() + 15_000;
    for (;;) {
      const probe = await db.runQuery({
        connectionId,
        queryId: `probe-${queryId}`,
        sql: `SELECT count(*)::int AS c
                FROM pg_stat_activity
               WHERE state = 'active'
                 AND pid <> pg_backend_pid()
                 AND position('pg_sleep' in query) > 0`,
      });
      if (((probe.rows[0]?.[0] as number) ?? 0) > 0) break;
      if (Date.now() > deadline) throw new Error('длинный запрос не стартовал за 15 с');
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const cancelled = await db.cancelQuery({ connectionId, queryId });
    expect(cancelled).toBe(true);

    const result = await outcome;
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : String(result.error)).toMatch(/canceling statement/i);
  });

  it('ошибка SQL возвращается как понятное исключение', async () => {
    await expect(
      db.runQuery({ connectionId, queryId: 'it-bad-1', sql: 'SELECT * FROM missing_table' }),
    ).rejects.toThrow(/missing_table/);
  });
});
