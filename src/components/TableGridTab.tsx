import { useCallback, useEffect, useRef, useState } from 'react';
import type { ColumnInfo, TablePage } from '../../shared/types';
import { api } from '../api';
import { displayCell, formatDuration, pluralRows, shortText } from '../lib/format';

interface Props {
  connectionId: string;
  schema: string;
  name: string;
  onColumnsLoaded(schema: string, name: string, columns: ColumnInfo[]): void;
}

const PAGE_SIZES = [50, 100, 200, 500];

interface CellEdit {
  row: number;
  col: number;
  text: string;
  isNull: boolean;
}

interface InsertState {
  texts: string[];
  isNull: boolean[];
  useDefault: boolean[];
}

/** Приводит введённый текст к типу исходного значения (для корректного сравнения). */
function coerce(text: string, original: unknown): unknown {
  if (typeof original === 'number') {
    const parsed = Number(text);
    return text.trim() !== '' && Number.isFinite(parsed) ? parsed : text;
  }
  if (typeof original === 'boolean') return text === 'true';
  return text;
}

export default function TableGridTab({ connectionId, schema, name, onColumnsLoaded }: Props) {
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [loadMs, setLoadMs] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [edit, setEdit] = useState<CellEdit | null>(null);
  const [insert, setInsert] = useState<InsertState | null>(null);
  const noticeTimer = useRef<number | null>(null);

  const flash = useCallback((message: string) => {
    setNotice(message);
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 3000);
  }, []);

  const load = useCallback(
    async (targetPage: number): Promise<TablePage | null> => {
      setLoading(true);
      setError(null);
      const res = await api.db.readTable({
        connectionId,
        schema,
        name,
        offset: targetPage * pageSize,
        limit: pageSize,
      });
      setLoading(false);
      if (!res.ok) {
        setError(res.error);
        return null;
      }
      const data = res.value;
      // Страница оказалась пустой (данные изменились) — откатываемся на последнюю.
      if (data.rows.length === 0 && data.total > 0 && targetPage > 0) {
        const lastPage = Math.max(0, Math.ceil(data.total / pageSize) - 1);
        if (lastPage < targetPage) return load(lastPage);
      }
      setColumns(data.columns);
      setRows(data.rows);
      setTotal(data.total);
      setPage(targetPage);
      setLoadMs(data.durationMs);
      onColumnsLoaded(schema, name, data.columns);
      return data;
    },
    [connectionId, schema, name, pageSize, onColumnsLoaded],
  );

  useEffect(() => {
    void load(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, schema, name, pageSize]);

  const maxPages = Math.max(1, Math.ceil(total / pageSize));

  function beginEdit(rowIndex: number, colIndex: number) {
    const value = rows[rowIndex]?.[colIndex];
    const isNull = value === null || value === undefined;
    setEdit({
      row: rowIndex,
      col: colIndex,
      text: isNull ? '' : displayCell(value),
      isNull,
    });
  }

  async function saveEdit() {
    if (!edit) return;
    const original = rows[edit.row];
    if (!original) return;
    const next = [...original];
    next[edit.col] = edit.isNull ? null : coerce(edit.text, original[edit.col]);

    const changed = original.some((value, index) => JSON.stringify(value) !== JSON.stringify(next[index]));
    if (!changed) {
      setEdit(null);
      return;
    }

    setBusy(true);
    setError(null);
    const res = await api.db.updateRow({ connectionId, schema, name, original, next });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return; // оставляем редактор, чтобы пользователь мог исправить значение
    }
    setEdit(null);
    if (res.value === 0) flash('Строка не найдена (возможно, она была изменена или удалена)');
    else flash('Строка обновлена');
    await load(page);
  }

  async function removeRow(rowIndex: number) {
    const original = rows[rowIndex];
    if (!original) return;
    if (!window.confirm('Удалить эту строку? Действие нельзя отменить.')) return;
    setBusy(true);
    setError(null);
    const res = await api.db.deleteRow({ connectionId, schema, name, original });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    flash(res.value > 0 ? 'Строка удалена' : 'Строка уже отсутствовала');
    await load(page);
  }

  function beginInsert() {
    setInsert({
      texts: columns.map(() => ''),
      isNull: columns.map(() => false),
      useDefault: columns.map((column) => column.defaultValue !== null),
    });
  }

  async function saveInsert() {
    if (!insert) return;
    const missing = columns.filter(
      (column, index) =>
        !insert.useDefault[index] &&
        insert.isNull[index] &&
        !column.nullable &&
        column.defaultValue === null,
    );
    if (missing.length > 0) {
      setError(
        `Столбцы ${missing.map((c) => c.name).join(', ')} не допускают NULL и не имеют значения по умолчанию`,
      );
      return;
    }
    const values = insert.texts.map((text, index) => (insert.isNull[index] ? null : text));
    setBusy(true);
    setError(null);
    const res = await api.db.insertRow({
      connectionId,
      schema,
      name,
      values,
      useDefault: insert.useDefault,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setInsert(null);
    flash('Строка добавлена');
    const targetPage = Math.max(0, Math.ceil((total + 1) / pageSize) - 1);
    await load(targetPage);
  }

  const renderValue = (value: unknown) => {
    const text = displayCell(value);
    return (
      <span className={value === null || value === undefined ? 'null-text' : ''} title={text}>
        {shortText(text)}
      </span>
    );
  };

  return (
    <div className="grid-tab">
      <div className="grid-toolbar">
        <div className="crumb">
          <b>{schema}</b>
          <span className="sep">/</span>
          {name}
          <span className="muted">
            · {pluralRows(total)}
            {loadMs > 0 ? ` · ${formatDuration(loadMs)}` : ''}
          </span>
        </div>
        <div className="toolbar-actions">
          <button onClick={() => void load(page)} disabled={loading || busy} title="Обновить">
            ⟳ Обновить
          </button>
          <button className="primary" onClick={beginInsert} disabled={!!insert || busy}>
            ＋ Строка
          </button>
        </div>
      </div>

      {error && (
        <div className="banner error">
          <span>{error}</span>
          <button className="icon-btn" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}
      {notice && (
        <div className="banner ok">
          <span>{notice}</span>
        </div>
      )}

      {insert && (
        <div className="insert-form">
          <div className="insert-title">Новая строка</div>
          <div className="insert-fields">
            {columns.map((column, index) => (
              <div className="field-row" key={column.name}>
                <label className="field-label" htmlFor={`ins-${column.name}`}>
                  {column.name}
                  <em title={column.defaultValue ? `DEFAULT ${column.defaultValue}` : column.type}>
                    {column.type}
                  </em>
                </label>
                <input
                  id={`ins-${column.name}`}
                  value={insert.texts[index]}
                  disabled={insert.useDefault[index] || insert.isNull[index]}
                  placeholder={
                    insert.useDefault[index]
                      ? 'по умолчанию'
                      : insert.isNull[index]
                        ? 'NULL'
                        : column.defaultValue
                          ? `DEFAULT: ${column.defaultValue}`
                          : ''
                  }
                  onChange={(event) => {
                    const texts = [...insert.texts];
                    texts[index] = event.target.value;
                    setInsert({ ...insert, texts });
                  }}
                />
                <button
                  className={`chip${insert.isNull[index] ? ' active' : ''}`}
                  disabled={insert.useDefault[index]}
                  title="Вставить NULL"
                  onClick={() => {
                    const isNull = [...insert.isNull];
                    isNull[index] = !isNull[index];
                    setInsert({ ...insert, isNull });
                  }}
                >
                  NULL
                </button>
                {column.defaultValue !== null && (
                  <button
                    className={`chip${insert.useDefault[index] ? ' active' : ''}`}
                    title={`Использовать DEFAULT (${column.defaultValue})`}
                    onClick={() => {
                      const useDefault = [...insert.useDefault];
                      useDefault[index] = !useDefault[index];
                      setInsert({ ...insert, useDefault });
                    }}
                  >
                    DEF
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="insert-actions">
            <button className="primary" onClick={() => void saveInsert()} disabled={busy}>
              Добавить
            </button>
            <button onClick={() => setInsert(null)} disabled={busy}>
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className={`grid-wrap${loading ? ' loading' : ''}`}>
        <table className="data-grid">
          <thead>
            <tr>
              <th className="rownum">#</th>
              {columns.map((column) => (
                <th key={column.name}>
                  <div className="col-name">
                    {column.name}
                    {column.primaryKey && <span className="pk-badge" title="Primary key">🔑</span>}
                  </div>
                  <div
                    className="col-type"
                    title={[
                      column.type,
                      column.nullable ? 'NULL' : 'NOT NULL',
                      column.defaultValue ? `DEFAULT ${column.defaultValue}` : '',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  >
                    {column.type}
                    {column.nullable ? '' : ' · NN'}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td className="rownum">
                  <button
                    className="row-delete"
                    title="Удалить строку"
                    disabled={busy}
                    onClick={() => void removeRow(rowIndex)}
                  >
                    ×
                  </button>
                  <span>{page * pageSize + rowIndex + 1}</span>
                </td>
                {row.map((value, cellIndex) => {
                  const isEditing = edit?.row === rowIndex && edit?.col === cellIndex;
                  return (
                    <td
                      key={cellIndex}
                      className={value === null || value === undefined ? 'null-cell' : ''}
                      onDoubleClick={() => !busy && beginEdit(rowIndex, cellIndex)}
                      title="Двойной клик — редактировать"
                    >
                      {isEditing && edit ? (
                        <div className="cell-edit">
                          <input
                            autoFocus
                            value={edit.text}
                            disabled={edit.isNull}
                            placeholder={edit.isNull ? 'NULL' : ''}
                            onChange={(event) => setEdit({ ...edit, text: event.target.value })}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') void saveEdit();
                              if (event.key === 'Escape') setEdit(null);
                            }}
                          />
                          <div className="cell-edit-btns">
                            <button
                              className={`chip${edit.isNull ? ' active' : ''}`}
                              title="Значение NULL"
                              onClick={() =>
                                setEdit({ ...edit, isNull: !edit.isNull, text: edit.isNull ? '' : edit.text })
                              }
                            >
                              ∅
                            </button>
                            <button className="ok" title="Сохранить" disabled={busy} onClick={() => void saveEdit()}>
                              ✓
                            </button>
                            <button title="Отмена" onClick={() => setEdit(null)}>
                              ✕
                            </button>
                          </div>
                        </div>
                      ) : (
                        renderValue(value)
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {rows.length === 0 && !loading && (
              <tr>
                <td className="empty" colSpan={columns.length + 1}>
                  {total === 0 ? 'Таблица пуста' : 'Нет строк на этой странице'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="grid-footer">
        <button disabled={page === 0 || loading || busy} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          ◀
        </button>
        <span>
          Страница {page + 1} из {maxPages}
        </span>
        <button
          disabled={page + 1 >= maxPages || loading || busy}
          onClick={() => setPage((p) => Math.min(maxPages - 1, p + 1))}
        >
          ▶
        </button>
        <label>
          Строк на странице:
          <select
            value={pageSize}
            onChange={(event) => {
              setEdit(null);
              setPageSize(Number(event.target.value));
              setPage(0);
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
        <span className="muted hint-right">Двойной клик по ячейке — изменить значение</span>
      </div>
    </div>
  );
}
