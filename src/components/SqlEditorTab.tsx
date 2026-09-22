import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorView, keymap } from '@codemirror/view';
import { PostgreSQL, sql, type SQLNamespace } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import type { ColumnInfo, SchemaInfo, TableInfo } from '../../shared/types';
import { api, uid } from '../api';
import type { SqlTab } from '../tabs';
import { formatDuration, pluralRows } from '../lib/format';
import ResultTable from './ResultTable';

interface Props {
  tab: SqlTab;
  connectionId: string;
  schemas: SchemaInfo[];
  tables: TableInfo[];
  columnsByTable: Record<string, ColumnInfo[]>;
  onPatch(patch: Partial<SqlTab>): void;
}

/** Схема/таблицы/столбцы → namespace для автодополнения CodeMirror. */
function buildSchema(tables: TableInfo[], columnsByTable: Record<string, ColumnInfo[]>): SQLNamespace {
  const bySchema = new Map<string, TableInfo[]>();
  for (const table of tables) {
    const list = bySchema.get(table.schema) ?? [];
    list.push(table);
    bySchema.set(table.schema, list);
  }
  const root: Record<string, SQLNamespace> = {};
  for (const [schema, list] of bySchema) {
    const tablesNs: Record<string, SQLNamespace> = {};
    for (const table of list) {
      const columns = columnsByTable[`${table.schema}.${table.name}`] ?? [];
      tablesNs[table.name] = columns.map((column) => ({
        label: column.name,
        detail: column.type,
      }));
    }
    root[schema] = tablesNs;
  }
  return root;
}

const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#c792ea', fontWeight: '600' },
  { tag: tags.operatorKeyword, color: '#c792ea' },
  { tag: tags.string, color: '#a5d6a7' },
  { tag: tags.special(tags.string), color: '#a5d6a7' },
  { tag: tags.number, color: '#f78c6c' },
  { tag: tags.bool, color: '#f78c6c' },
  { tag: tags.null, color: '#f78c6c' },
  { tag: tags.comment, color: '#5b6376', fontStyle: 'italic' },
  { tag: tags.typeName, color: '#82aaff' },
  { tag: tags.standard(tags.typeName), color: '#82aaff' },
  { tag: tags.variableName, color: '#e6e9ef' },
  { tag: tags.definition(tags.variableName), color: '#82aaff' },
  { tag: tags.propertyName, color: '#e6e9ef' },
  { tag: tags.operator, color: '#89ddff' },
  { tag: tags.bracket, color: '#8b93a5' },
  { tag: tags.punctuation, color: '#8b93a5' },
  { tag: tags.meta, color: '#f78c6c' },
  { tag: tags.link, color: '#82aaff' },
]);

const editorTheme = EditorView.theme(
  {
    '&': {
      backgroundColor: '#0f1115',
      color: '#e6e9ef',
      fontSize: '13px',
      height: '100%',
    },
    '.cm-scroller': {
      fontFamily:
        "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace",
      lineHeight: '1.55',
    },
    '.cm-content': { padding: '8px 0', caretColor: '#4f8cff' },
    '.cm-gutters': {
      backgroundColor: '#0f1115',
      color: '#4a5162',
      border: 'none',
      borderRight: '1px solid #1c212b',
    },
    '.cm-activeLine': { backgroundColor: '#141922' },
    '.cm-activeLineGutter': { backgroundColor: '#141922', color: '#8b93a5' },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#2a3b5c',
    },
    '&.cm-focused .cm-cursor': { borderLeftColor: '#4f8cff' },
    '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
      backgroundColor: '#2a3b5c',
      outline: 'none',
    },
    '.cm-panels': { backgroundColor: '#161a21', color: '#e6e9ef', borderColor: '#262b36' },
    '.cm-tooltip': {
      backgroundColor: '#161a21',
      border: '1px solid #262b36',
      color: '#e6e9ef',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: '#2a3b5c',
      color: '#ffffff',
    },
    '.cm-tooltip-autocomplete ul li': { padding: '2px 8px' },
    '.cm-completionIcon': { color: '#8b93a5' },
  },
  { dark: true },
);

const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

export default function SqlEditorTab({
  tab,
  connectionId,
  schemas,
  tables,
  columnsByTable,
  onPatch,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const runRef = useRef<() => void>(() => undefined);
  const patchRef = useRef(onPatch);
  patchRef.current = onPatch;

  const schemaKey = `${tables.length}:${Object.keys(columnsByTable).length}:${schemas.length}`;

  async function run() {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    if (!text.trim()) {
      patchRef.current({ result: { running: false, error: 'Введите SQL-запрос' } });
      return;
    }
    const queryId = uid();
    patchRef.current({ result: { running: true, queryId } });
    const res = await api.db.query({ connectionId, sql: text, queryId });
    if (res.ok) patchRef.current({ result: { running: false, result: res.value } });
    else patchRef.current({ result: { running: false, error: res.error } });
  }
  runRef.current = () => void run();

  async function cancel() {
    const queryId = tab.result?.queryId;
    if (queryId) await api.db.cancel({ connectionId, queryId });
  }

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const defaultSchema =
      schemas.some((schema) => schema.name === 'public')
        ? 'public'
        : schemas[0]?.name;

    const view = new EditorView({
      doc: tab.content,
      parent: host,
      extensions: [
        basicSetup,
        keymap.of([
          {
            key: 'Mod-Enter',
            run: () => {
              runRef.current();
              return true;
            },
          },
        ]),
        sql({
          dialect: PostgreSQL,
          schema: buildSchema(tables, columnsByTable),
          ...(defaultSchema ? { defaultSchema } : {}),
          upperCaseKeywords: true,
        }),
        syntaxHighlighting(highlightStyle),
        EditorView.lineWrapping,
        editorTheme,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) patchRef.current({ content: update.state.doc.toString() });
        }),
      ],
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // schemaKey — пересоздаём редактор, когда подгрузилась структура БД
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, schemaKey]);

  const state = tab.result;
  const running = Boolean(state?.running);
  const result = state?.result;

  return (
    <div className="editor-tab">
      <div className="editor-toolbar">
        <button
          className="primary"
          onClick={() => void run()}
          disabled={running}
          title="Выполнить запрос"
        >
          ▶ Выполнить <kbd>{isMac() ? '⌘↵' : 'Ctrl+↵'}</kbd>
        </button>
        <button onClick={() => void cancel()} disabled={!running} title="Отменить запрос">
          ■ Отменить
        </button>
        <div className="spacer" />
        {result && (
          <span className="status ok">
            ✓ {result.rowCount ?? 0} · {formatDuration(result.durationMs)}
          </span>
        )}
        <button
          onClick={() => onPatch({ result: undefined })}
          disabled={!state || running}
          title="Скрыть результат"
        >
          Очистить результат
        </button>
      </div>

      <div className="editor-host" ref={hostRef} />

      <div className="result-panel">
        {!state && (
          <div className="muted hint">
            Напишите запрос и нажмите «Выполнить» ({isMac() ? '⌘' : 'Ctrl'}+Enter). Начните вводить
            имя таблицы — подключится автодополнение из вашей схемы.
          </div>
        )}

        {state?.running && (
          <div className="status running">
            <span className="spinner" /> Выполняется запрос…
          </div>
        )}

        {state?.error && (
          <div className="banner error">
            <span className="error-text">{state.error}</span>
          </div>
        )}

        {result && (
          <>
            <div className="result-head">
              <span className="status ok">
                ✓ {pluralRows(result.rowCount ?? result.rows.length)} за{' '}
                {formatDuration(result.durationMs)}
              </span>
              {result.truncated && (
                <span className="status warn">
                  ⚠ показаны только первые {result.rows.length} строк — уточните выборку
                </span>
              )}
            </div>
            {result.columns.length > 0 ? (
              <ResultTable columns={result.columns} rows={result.rows} />
            ) : (
              <div className="muted pad">
                Команда выполнена, затронуто строк: {result.rowCount ?? 0}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
