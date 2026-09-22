import { useState } from 'react';
import type { SchemaInfo, TableInfo } from '../../shared/types';

interface Props {
  schemas: SchemaInfo[];
  tables: TableInfo[];
  loading: boolean;
  error: string | null;
  connectionLabel: string;
  onOpenTable(schema: string, name: string): void;
  onRefresh(): void;
}

const KIND_ICON: Record<TableInfo['kind'], string> = {
  table: '▦',
  partitioned: '▦',
  view: '◉',
  materialized: '◐',
  foreign: '⇄',
};

const KIND_TITLE: Record<TableInfo['kind'], string> = {
  table: 'Таблица',
  partitioned: 'Секционированная таблица',
  view: 'Представление',
  materialized: 'Материализованное представление',
  foreign: 'Foreign-таблица',
};

export default function Sidebar({
  schemas,
  tables,
  loading,
  error,
  connectionLabel,
  onOpenTable,
  onRefresh,
}: Props) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (schema: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(schema)) next.delete(schema);
      else next.add(schema);
      return next;
    });
  };

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <span className="conn-dot" title="Подключено" />
        <span className="conn-label" title={connectionLabel}>
          {connectionLabel}
        </span>
        <button className="icon-btn" title="Обновить структуру" onClick={onRefresh}>
          ⟳
        </button>
      </div>

      {error && <div className="banner error compact">{error}</div>}

      <div className="tree">
        {loading && <div className="muted pad">Загрузка структуры…</div>}
        {!loading &&
          schemas.map((schema) => {
            const items = tables.filter((table) => table.schema === schema.name);
            const isCollapsed = collapsed.has(schema.name);
            const regular = items.filter((t) => t.kind === 'table' || t.kind === 'partitioned');
            const views = items.filter((t) => t.kind !== 'table' && t.kind !== 'partitioned');
            return (
              <div key={schema.name} className="tree-schema">
                <button
                  className="tree-row tree-schema-row"
                  onClick={() => toggle(schema.name)}
                  title={isCollapsed ? 'Показать объекты' : 'Скрыть объекты'}
                >
                  <span className="chevron">{isCollapsed ? '▸' : '▾'}</span>
                  <span className="schema-name">{schema.name}</span>
                  <span className="count">{items.length}</span>
                </button>

                {!isCollapsed && (
                  <div className="tree-items">
                    {items.length === 0 && (
                      <div className="muted small pad-sm">Нет таблиц и представлений</div>
                    )}
                    {regular.length > 0 && items[0] === regular[0] && (
                      <div className="tree-group">Таблицы</div>
                    )}
                    {regular.map((table) => (
                      <button
                        key={`${table.schema}.${table.name}`}
                        className="tree-row tree-table"
                        onClick={() => onOpenTable(table.schema, table.name)}
                        title={`${KIND_TITLE[table.kind]} — открыть данные`}
                      >
                        <span className="chevron ghost" />
                        <span className={`kind kind-${table.kind}`}>{KIND_ICON[table.kind]}</span>
                        <span className="table-name">{table.name}</span>
                      </button>
                    ))}
                    {views.length > 0 && <div className="tree-group">Представления</div>}
                    {views.map((table) => (
                      <button
                        key={`${table.schema}.${table.name}`}
                        className="tree-row tree-table"
                        onClick={() => onOpenTable(table.schema, table.name)}
                        title={`${KIND_TITLE[table.kind]} — открыть данные`}
                      >
                        <span className="chevron ghost" />
                        <span className={`kind kind-${table.kind}`}>{KIND_ICON[table.kind]}</span>
                        <span className="table-name">{table.name}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        {!loading && schemas.length === 0 && !error && (
          <div className="muted pad">Нет объектов для отображения</div>
        )}
      </div>
    </aside>
  );
}
