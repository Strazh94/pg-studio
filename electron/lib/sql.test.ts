import { describe, expect, it } from 'vitest';
import {
  buildCount,
  buildDelete,
  buildInsert,
  buildSelectPage,
  buildUpdate,
  buildWhere,
  keyPairsFor,
  quoteIdent,
  qualified,
  sameValue,
  toJsonSafe,
} from './sql';
import type { ColumnInfo } from '../../shared/types';

const columns: ColumnInfo[] = [
  { name: 'id', type: 'integer', nullable: false, defaultValue: null, primaryKey: true },
  { name: 'name', type: 'text', nullable: true, defaultValue: null, primaryKey: false },
  { name: 'note', type: 'text', nullable: true, defaultValue: "'-'::text", primaryKey: false },
];

describe('quoteIdent', () => {
  it('экранирование кавычек', () => {
    expect(quoteIdent('users')).toBe('"users"');
    expect(quoteIdent('weird"name')).toBe('"weird""name"');
  });

  it('квалификация схемой', () => {
    expect(qualified('public', 'users')).toBe('"public"."users"');
  });
});

describe('toJsonSafe', () => {
  it('дата → ISO-строка', () => {
    const date = new Date('2026-09-22T10:00:00.000Z');
    expect(toJsonSafe(date)).toBe('2026-09-22T10:00:00.000Z');
  });

  it('bytea → \\x-строка', () => {
    expect(toJsonSafe(Buffer.from([0xde, 0xad]))).toBe('\\xdead');
  });

  it('bigint → строка, NaN → строка', () => {
    expect(toJsonSafe(10n)).toBe('10');
    expect(toJsonSafe(Number.NaN)).toBe('NaN');
  });

  it('массивы и объекты рекурсивно', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    expect(toJsonSafe([1, date, null])).toEqual([1, '2026-01-01T00:00:00.000Z', null]);
    expect(toJsonSafe({ a: 1, b: date })).toEqual({ a: 1, b: '2026-01-01T00:00:00.000Z' });
  });

  it('null и undefined → null', () => {
    expect(toJsonSafe(null)).toBeNull();
    expect(toJsonSafe(undefined)).toBeNull();
  });
});

describe('sameValue', () => {
  it('сравнение примитивов и структур', () => {
    expect(sameValue(null, null)).toBe(true);
    expect(sameValue(null, undefined)).toBe(false);
    expect(sameValue([1, 2], [1, 2])).toBe(true);
    expect(sameValue({ a: 1 }, { a: 2 })).toBe(false);
  });
});

describe('buildWhere', () => {
  it('IS NOT DISTINCT FROM с нумерацией с заданного индекса', () => {
    const where = buildWhere(
      [
        { name: 'id', value: 5 },
        { name: 'note', value: null },
      ],
      3,
    );
    expect(where.sql).toBe('"id" IS NOT DISTINCT FROM $3 AND "note" IS NOT DISTINCT FROM $4');
    expect(where.params).toEqual([5, null]);
  });
});

describe('keyPairsFor', () => {
  it('использует PK, если он есть', () => {
    expect(keyPairsFor(columns, [7, 'a', 'b'])).toEqual([{ name: 'id', value: 7 }]);
  });

  it('без PK использует все столбцы', () => {
    const noPk = columns.map((c) => ({ ...c, primaryKey: false }));
    expect(keyPairsFor(noPk, [7, 'a', 'b'])).toEqual([
      { name: 'id', value: 7 },
      { name: 'name', value: 'a' },
      { name: 'note', value: 'b' },
    ]);
  });
});

describe('buildUpdate', () => {
  it('обновляет только изменённые столбцы', () => {
    const statement = buildUpdate('public', 'users', columns, [1, 'old', 'n'], [1, 'new', 'n']);
    expect(statement).not.toBeNull();
    expect(statement!.sql).toBe(
      'UPDATE "public"."users" SET "name" = $1 WHERE "id" IS NOT DISTINCT FROM $2',
    );
    expect(statement!.params).toEqual(['new', 1]);
  });

  it('null-изменения корректно попадают в SET', () => {
    const statement = buildUpdate('public', 'users', columns, [1, 'a', 'n'], [1, null, 'n']);
    expect(statement!.sql).toContain('"name" = $1');
    expect(statement!.params).toEqual([null, 1]);
  });

  it('нет изменений → null', () => {
    expect(buildUpdate('public', 'users', columns, [1, 'a', 'b'], [1, 'a', 'b'])).toBeNull();
  });
});

describe('buildDelete', () => {
  it('удаляет по PK', () => {
    const statement = buildDelete('public', 'users', columns, [3, 'x', 'y']);
    expect(statement.sql).toBe('DELETE FROM "public"."users" WHERE "id" IS NOT DISTINCT FROM $1');
    expect(statement.params).toEqual([3]);
  });
});

describe('buildInsert', () => {
  it('вставляет только нужные столбцы', () => {
    const statement = buildInsert(
      'public',
      'users',
      columns,
      [1, 'ivan', 'ignored'],
      [false, false, true],
    );
    expect(statement.sql).toBe(
      'INSERT INTO "public"."users" ("id", "name") VALUES ($1, $2)',
    );
    expect(statement.params).toEqual([1, 'ivan']);
  });

  it('все по умолчанию → DEFAULT VALUES', () => {
    const statement = buildInsert('public', 'users', columns, [], [true, true, true]);
    expect(statement.sql).toBe('INSERT INTO "public"."users" DEFAULT VALUES');
    expect(statement.params).toEqual([]);
  });
});

describe('buildSelectPage / buildCount', () => {
  it('страница сортируется по PK', () => {
    const statement = buildSelectPage('public', 'users', columns, 100, 200);
    expect(statement.sql).toBe(
      'SELECT * FROM "public"."users" ORDER BY "id" LIMIT $1 OFFSET $2',
    );
    expect(statement.params).toEqual([100, 200]);
  });

  it('без PK — сортировка по ctid', () => {
    const noPk = columns.map((c) => ({ ...c, primaryKey: false }));
    const statement = buildSelectPage('public', 'users', noPk, 50, 0);
    expect(statement.sql).toContain('ORDER BY "ctid"');
  });

  it('count через bigint', () => {
    expect(buildCount('public', 'users')).toBe(
      'SELECT count(*)::bigint AS total FROM "public"."users"',
    );
  });
});
