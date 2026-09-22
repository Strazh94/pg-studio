import { useCallback, useEffect, useState } from 'react';
import type { ColumnInfo, ConnectionSummary, SchemaInfo, TableInfo } from '../shared/types';
import { api, uid } from './api';
import ConnectionDialog from './components/ConnectionDialog';
import Sidebar from './components/Sidebar';
import SqlEditorTab from './components/SqlEditorTab';
import TabBar from './components/TabBar';
import TableGridTab from './components/TableGridTab';
import type { SqlTab, Tab } from './tabs';

const LAST_CONNECTION_KEY = 'pgstudio:lastConnection';

export default function App() {
  const [booted, setBooted] = useState(false);
  const [connections, setConnections] = useState<ConnectionSummary[]>([]);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [schemas, setSchemas] = useState<SchemaInfo[]>([]);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [columnsByTable, setColumnsByTable] = useState<Record<string, ColumnInfo[]>>({});
  const [schemaLoading, setSchemaLoading] = useState(false);
  const [schemaError, setSchemaError] = useState<string | null>(null);

  const activeConnection = connections.find((item) => item.id === connectionId) ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  const loadSchema = useCallback(async (id: string) => {
    setSchemaLoading(true);
    setSchemaError(null);
    const [schemasRes, tablesRes] = await Promise.all([api.db.schemas(id), api.db.tables(id)]);
    setSchemaLoading(false);
    if (schemasRes.ok && tablesRes.ok) {
      setSchemas(schemasRes.value);
      setTables(tablesRes.value);
    } else {
      setSchemaError(!schemasRes.ok ? schemasRes.error : !tablesRes.ok ? tablesRes.error : null);
    }
  }, []);

  const connect = useCallback(
    (id: string) => {
      setConnectionId(id);
      setTabs([]);
      setActiveTabId(null);
      setSchemas([]);
      setTables([]);
      setColumnsByTable({});
      setSchemaError(null);
      try {
        localStorage.setItem(LAST_CONNECTION_KEY, id);
      } catch {
        // localStorage может быть недоступен — не критично
      }
      setDialogOpen(false);
      void loadSchema(id);
    },
    [loadSchema],
  );

  // Старт приложения: список подключений и авто-подключение к последнему.
  useEffect(() => {
    void (async () => {
      const res = await api.connections.list();
      const list = res.ok ? res.value : [];
      setConnections(list);
      setBooted(true);
      let saved: string | null = null;
      try {
        saved = localStorage.getItem(LAST_CONNECTION_KEY);
      } catch {
        saved = null;
      }
      const target =
        saved && list.some((item) => item.id === saved)
          ? saved
          : list.length === 1
            ? list[0].id
            : null;
      if (target) connect(target);
      else setDialogOpen(true);
    })();
  }, [connect]);

  const patchTab = useCallback((id: string, patch: Partial<Tab>) => {
    setTabs((prev) => prev.map((tab) => (tab.id === id ? ({ ...tab, ...patch } as Tab) : tab)));
  }, []);

  const openSqlTab = useCallback(() => {
    const id = uid();
    setTabs((prev) => {
      const number = prev.filter((tab) => tab.kind === 'sql').length + 1;
      const newTab: SqlTab = { id, kind: 'sql', title: `Запрос ${number}`, content: '' };
      return [...prev, newTab];
    });
    setActiveTabId(id);
  }, []);

  const openTableTab = useCallback(
    (schema: string, name: string) => {
      const existing = tabs.find(
        (tab) => tab.kind === 'table' && tab.schema === schema && tab.name === name,
      );
      if (existing) {
        setActiveTabId(existing.id);
        return;
      }
      const id = uid();
      setTabs((prev) => [...prev, { id, kind: 'table', schema, name }]);
      setActiveTabId(id);
    },
    [tabs],
  );

  const closeTab = useCallback(
    (id: string) => {
      const index = tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return;
      const next = tabs.filter((tab) => tab.id !== id);
      setTabs(next);
      if (activeTabId === id) {
        const fallback = next[Math.min(index, next.length - 1)];
        setActiveTabId(fallback ? fallback.id : null);
      }
    },
    [tabs, activeTabId],
  );

  const handleColumnsLoaded = useCallback((schema: string, name: string, columns: ColumnInfo[]) => {
    setColumnsByTable((prev) => {
      const key = `${schema}.${name}`;
      if (prev[key] === columns) return prev;
      return { ...prev, [key]: columns };
    });
  }, []);

  if (!booted) {
    return (
      <div className="splash">
        <div className="splash-brand">PG Studio</div>
        <div className="muted">Запуск…</div>
      </div>
    );
  }

  const connectionLabel = activeConnection
    ? `${activeConnection.user}@${activeConnection.host}:${activeConnection.port}/${activeConnection.database}`
    : 'Нет подключения';

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">PG Studio</div>
        <button
          className={`conn-btn${connectionId ? ' connected' : ''}`}
          onClick={() => setDialogOpen(true)}
          title="Управление подключениями"
        >
          <span className={`conn-dot${connectionId ? '' : ' off'}`} />
          {connectionLabel}
        </button>
        <div className="spacer" />
        <button
          onClick={() => connectionId && void loadSchema(connectionId)}
          disabled={!connectionId || schemaLoading}
          title="Обновить структуру базы"
        >
          {schemaLoading ? 'Загрузка…' : '⟳ Структура'}
        </button>
        <button
          className="primary"
          onClick={openSqlTab}
          disabled={!connectionId}
          title="Новая вкладка SQL-запроса"
        >
          ＋ Запрос
        </button>
      </header>

      <div className="workspace">
        <Sidebar
          schemas={schemas}
          tables={tables}
          loading={schemaLoading}
          error={schemaError}
          connectionLabel={connectionLabel}
          onOpenTable={openTableTab}
          onRefresh={() => connectionId && void loadSchema(connectionId)}
        />

        <main className="main">
          <TabBar
            tabs={tabs}
            activeId={activeTabId}
            onSelect={setActiveTabId}
            onClose={closeTab}
            onNew={openSqlTab}
          />

          <div className="content">
            {connectionId && activeTab?.kind === 'sql' && (
              <SqlEditorTab
                key={activeTab.id}
                tab={activeTab}
                connectionId={connectionId}
                schemas={schemas}
                tables={tables}
                columnsByTable={columnsByTable}
                onPatch={(patch) => patchTab(activeTab.id, patch)}
              />
            )}

            {connectionId && activeTab?.kind === 'table' && (
              <TableGridTab
                key={`${activeTab.schema}.${activeTab.name}`}
                connectionId={connectionId}
                schema={activeTab.schema}
                name={activeTab.name}
                onColumnsLoaded={handleColumnsLoaded}
              />
            )}

            {!activeTab && (
              <div className="empty-state">
                <div className="empty-brand">PG Studio</div>
                {connectionId ? (
                  <>
                    <p className="muted">
                      Выберите таблицу слева или создайте SQL-запрос.
                    </p>
                    <div className="empty-actions">
                      <button className="primary" onClick={openSqlTab}>
                        ▶ Новый SQL-запрос
                      </button>
                      <button onClick={() => setDialogOpen(true)}>Подключения</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="muted">Подключитесь к базе данных, чтобы начать работу.</p>
                    <div className="empty-actions">
                      <button className="primary" onClick={() => setDialogOpen(true)}>
                        Подключиться к PostgreSQL
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </main>
      </div>

      {dialogOpen && (
        <ConnectionDialog
          connections={connections}
          activeId={connectionId}
          onConnectionsChange={(list) => {
            setConnections(list);
            if (connectionId && !list.some((item) => item.id === connectionId)) {
              setConnectionId(null);
              setTabs([]);
              setActiveTabId(null);
              setSchemas([]);
              setTables([]);
            }
          }}
          onConnect={connect}
          onClose={() => setDialogOpen(false)}
        />
      )}
    </div>
  );
}
