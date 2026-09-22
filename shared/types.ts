/** Общие типы, используемые и main-процессом Electron, и React-рендером. */

export interface ConnectionConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export type ConnectionSummary = Omit<ConnectionConfig, 'password'> & {
  hasPassword: boolean;
};

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export type TableKind = 'table' | 'partitioned' | 'view' | 'materialized' | 'foreign';

export interface SchemaInfo {
  name: string;
}

export interface TableInfo {
  schema: string;
  name: string;
  kind: TableKind;
}

export interface QueryColumn {
  name: string;
  type: string;
}

export interface QueryResult {
  columns: QueryColumn[];
  rows: unknown[][];
  rowCount: number | null;
  truncated: boolean;
  durationMs: number;
}

export interface TablePage extends QueryResult {
  total: number;
  /** Столбцы с метаданными (типы, PK, default) — нужно сетке для редактирования. */
  columns: ColumnInfo[];
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  defaultValue: string | null;
  primaryKey: boolean;
}

export interface SaveConnectionResult {
  id: string;
  list: ConnectionSummary[];
}

export interface QueryInput {
  connectionId: string;
  sql: string;
  queryId: string;
}

export interface CancelInput {
  connectionId: string;
  queryId: string;
}

export interface TableRef {
  connectionId: string;
  schema: string;
  name: string;
}

export interface ReadTableInput extends TableRef {
  offset: number;
  limit: number;
}

export interface InsertRowInput extends TableRef {
  /** Значения в порядке столбцов таблицы. */
  values: unknown[];
  /** true — не включать столбец в INSERT (использовать DEFAULT). */
  useDefault: boolean[];
}

export interface UpdateRowInput extends TableRef {
  original: unknown[];
  next: unknown[];
}

export interface DeleteRowInput extends TableRef {
  original: unknown[];
}

export interface PgStudioApi {
  connections: {
    list(): Promise<Result<ConnectionSummary[]>>;
    save(config: ConnectionConfig): Promise<Result<SaveConnectionResult>>;
    remove(id: string): Promise<Result<ConnectionSummary[]>>;
    test(config: ConnectionConfig): Promise<Result<string>>;
  };
  db: {
    query(input: QueryInput): Promise<Result<QueryResult>>;
    cancel(input: CancelInput): Promise<Result<boolean>>;
    schemas(connectionId: string): Promise<Result<SchemaInfo[]>>;
    tables(connectionId: string): Promise<Result<TableInfo[]>>;
    columns(input: TableRef): Promise<Result<ColumnInfo[]>>;
    readTable(input: ReadTableInput): Promise<Result<TablePage>>;
    insertRow(input: InsertRowInput): Promise<Result<number>>;
    updateRow(input: UpdateRowInput): Promise<Result<number>>;
    deleteRow(input: DeleteRowInput): Promise<Result<number>>;
  };
}
