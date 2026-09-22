import type { Tab } from '../tabs';

interface Props {
  tabs: Tab[];
  activeId: string | null;
  onSelect(id: string): void;
  onClose(id: string): void;
  onNew(): void;
}

export default function TabBar({ tabs, activeId, onSelect, onClose, onNew }: Props) {
  if (tabs.length === 0) return null;
  return (
    <div className="tabbar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeId}
          className={`tab${tab.id === activeId ? ' active' : ''}${
            tab.kind === 'table' ? ' table-tab' : ''
          }`}
          onClick={() => onSelect(tab.id)}
          title={tab.kind === 'table' ? `${tab.schema}.${tab.name}` : tab.title}
        >
          <span className="tab-icon">{tab.kind === 'sql' ? 'SQL' : '▦'}</span>
          <span className="tab-title">{tab.kind === 'sql' ? tab.title : tab.name}</span>
          <button
            className="tab-close"
            title="Закрыть вкладку"
            onClick={(event) => {
              event.stopPropagation();
              onClose(tab.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
      <button className="tab-new" title="Новый SQL-запрос" onClick={onNew}>
        +
      </button>
    </div>
  );
}
