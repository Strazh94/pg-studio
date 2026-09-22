import { ipcMain } from 'electron';
import type {
  CancelInput,
  ConnectionConfig,
  DeleteRowInput,
  InsertRowInput,
  QueryInput,
  ReadTableInput,
  TableRef,
  UpdateRowInput,
} from '../shared/types';
import { guard } from './lib/result';
import * as connections from './lib/connections';
import * as db from './lib/db';

type Handler = (...args: never[]) => unknown;

/** Каждый канал возвращает Result<T>, чтобы рендер не ловил исключений. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, (_event, ...args) =>
    guard(async () => (fn as (...a: unknown[]) => unknown)(...args)),
  );
}

export function registerIpc(): void {
  handle('conn:list', () => connections.listConnections());
  handle('conn:save', (config: ConnectionConfig) => connections.saveConnection(config));
  handle('conn:remove', async (id: string) => {
    await db.closePool(id);
    return connections.removeConnection(id);
  });
  handle('conn:test', (config: ConnectionConfig) => db.testConnection(config));

  handle('db:query', (input: QueryInput) => db.runQuery(input));
  handle('db:cancel', (input: CancelInput) => db.cancelQuery(input));
  handle('db:schemas', (connectionId: string) => db.getSchemas(connectionId));
  handle('db:tables', (connectionId: string) => db.getTables(connectionId));
  handle('db:columns', (input: TableRef) => db.getColumnsFor(input));
  handle('db:read', (input: ReadTableInput) => db.readTable(input));
  handle('db:insert', (input: InsertRowInput) => db.insertRow(input));
  handle('db:update', (input: UpdateRowInput) => db.updateRow(input));
  handle('db:delete', (input: DeleteRowInput) => db.deleteRow(input));
}
