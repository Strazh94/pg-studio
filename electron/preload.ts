import { contextBridge, ipcRenderer } from 'electron';
import type { PgStudioApi } from '../shared/types';

/**
 * Единственная «дверь» рендера в main-процесс.
 * Только типизированные вызовы — никакого доступа к Node из React.
 */
const api: PgStudioApi = {
  connections: {
    list: () => ipcRenderer.invoke('conn:list'),
    save: (config) => ipcRenderer.invoke('conn:save', config),
    remove: (id) => ipcRenderer.invoke('conn:remove', id),
    test: (config) => ipcRenderer.invoke('conn:test', config),
  },
  db: {
    query: (input) => ipcRenderer.invoke('db:query', input),
    cancel: (input) => ipcRenderer.invoke('db:cancel', input),
    schemas: (connectionId) => ipcRenderer.invoke('db:schemas', connectionId),
    tables: (connectionId) => ipcRenderer.invoke('db:tables', connectionId),
    columns: (input) => ipcRenderer.invoke('db:columns', input),
    readTable: (input) => ipcRenderer.invoke('db:read', input),
    insertRow: (input) => ipcRenderer.invoke('db:insert', input),
    updateRow: (input) => ipcRenderer.invoke('db:update', input),
    deleteRow: (input) => ipcRenderer.invoke('db:delete', input),
  },
};

contextBridge.exposeInMainWorld('api', api);
