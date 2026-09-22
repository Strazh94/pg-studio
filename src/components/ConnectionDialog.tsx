import { useEffect, useState } from 'react';
import type { ConnectionConfig, ConnectionSummary } from '../../shared/types';
import { api } from '../api';

interface Props {
  connections: ConnectionSummary[];
  activeId: string | null;
  onConnectionsChange(list: ConnectionSummary[]): void;
  onConnect(id: string): void;
  onClose(): void;
}

interface FormState {
  id: string;
  name: string;
  host: string;
  port: string;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

const EMPTY_FORM: FormState = {
  id: 'new',
  name: '',
  host: 'localhost',
  port: '5432',
  database: 'postgres',
  user: 'postgres',
  password: '',
  ssl: false,
};

function fromSummary(summary: ConnectionSummary): FormState {
  return {
    id: summary.id,
    name: summary.name,
    host: summary.host,
    port: String(summary.port),
    database: summary.database,
    user: summary.user,
    password: '',
    ssl: summary.ssl,
  };
}

function toConfig(form: FormState): ConnectionConfig {
  return {
    id: form.id,
    name: form.name.trim(),
    host: form.host.trim(),
    port: Number(form.port) || 5432,
    database: form.database.trim(),
    user: form.user.trim(),
    password: form.password,
    ssl: form.ssl,
  };
}

export default function ConnectionDialog({
  connections,
  activeId,
  onConnectionsChange,
  onConnect,
  onClose,
}: Props) {
  const [mode, setMode] = useState<'list' | 'form'>(connections.length === 0 ? 'form' : 'list');
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [error, setError] = useState<string | null>(null);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [connectingId, setConnectingId] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (mode === 'form' && connections.length > 0) {
        setMode('list');
        setError(null);
        setTestMessage(null);
      } else {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, connections.length, onClose]);

  function openForm(summary?: ConnectionSummary) {
    setForm(summary ? fromSummary(summary) : EMPTY_FORM);
    setError(null);
    setTestMessage(null);
    setMode('form');
  }

  async function test() {
    setBusy(true);
    setError(null);
    setTestMessage(null);
    const res = await api.connections.test(toConfig(form));
    setBusy(false);
    if (res.ok) setTestMessage({ ok: true, text: `Соединение установлено: ${res.value}` });
    else setTestMessage({ ok: false, text: res.error });
  }

  async function save(connectAfter: boolean) {
    setBusy(true);
    setError(null);
    const res = await api.connections.save(toConfig(form));
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onConnectionsChange(res.value.list);
    if (connectAfter) {
      onConnect(res.value.id);
      return;
    }
    setMode('list');
  }

  async function connect(id: string) {
    setConnectingId(id);
    setError(null);
    const summary = connections.find((item) => item.id === id);
    if (summary) {
      const res = await api.connections.test(toConfig(fromSummary(summary)));
      setConnectingId(null);
      if (!res.ok) {
        setError(res.error);
        return;
      }
    } else {
      setConnectingId(null);
    }
    onConnect(id);
  }

  async function remove(id: string) {
    const summary = connections.find((item) => item.id === id);
    if (!window.confirm(`Удалить подключение «${summary?.name ?? id}»?`)) return;
    const res = await api.connections.remove(id);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    onConnectionsChange(res.value);
  }

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-label="Подключения">
        <div className="dialog-head">
          <h2>{mode === 'list' ? 'Подключения' : form.id === 'new' ? 'Новое подключение' : 'Редактирование подключения'}</h2>
          <button className="icon-btn" title="Закрыть" onClick={onClose}>
            ×
          </button>
        </div>

        {error && <div className="banner error">{error}</div>}

        {mode === 'list' ? (
          <div className="conn-list">
            {connections.length === 0 && (
              <div className="muted pad">Сохранённых подключений пока нет</div>
            )}
            {connections.map((summary) => (
              <div key={summary.id} className={`conn-item${summary.id === activeId ? ' active' : ''}`}>
                <div className="conn-info">
                  <div className="conn-name">{summary.name}</div>
                  <div className="conn-meta">
                    {summary.user}@{summary.host}:{summary.port}/{summary.database}
                    {summary.ssl ? ' · SSL' : ''}
                  </div>
                </div>
                <div className="conn-actions">
                  <button
                    className="primary"
                    disabled={connectingId === summary.id}
                    onClick={() => void connect(summary.id)}
                  >
                    {connectingId === summary.id ? 'Подключение…' : summary.id === activeId ? 'Активно' : 'Подключиться'}
                  </button>
                  <button onClick={() => openForm(summary)}>Изменить</button>
                  <button className="danger" onClick={() => void remove(summary.id)}>
                    Удалить
                  </button>
                </div>
              </div>
            ))}
            <div className="dialog-actions">
              <button className="primary" onClick={() => openForm()}>
                ＋ Новое подключение
              </button>
            </div>
          </div>
        ) : (
          <form
            className="conn-form"
            onSubmit={(event) => {
              event.preventDefault();
              void save(true);
            }}
          >
            <label>
              Название
              <input
                value={form.name}
                placeholder="Локальный PostgreSQL"
                onChange={(event) => set('name', event.target.value)}
              />
            </label>
            <div className="form-grid">
              <label className="grow">
                Хост
                <input value={form.host} onChange={(event) => set('host', event.target.value)} required />
              </label>
              <label className="narrow">
                Порт
                <input
                  value={form.port}
                  inputMode="numeric"
                  onChange={(event) => set('port', event.target.value)}
                  required
                />
              </label>
            </div>
            <label>
              База данных
              <input
                value={form.database}
                onChange={(event) => set('database', event.target.value)}
                required
              />
            </label>
            <label>
              Пользователь
              <input value={form.user} onChange={(event) => set('user', event.target.value)} required />
            </label>
            <label>
              Пароль
              <input
                type="password"
                value={form.password}
                placeholder={
                  connections.some((item) => item.id === form.id && item.hasPassword)
                    ? '•••••• (оставьте пустым, чтобы не менять)'
                    : ''
                }
                onChange={(event) => set('password', event.target.value)}
                autoComplete="off"
              />
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.ssl}
                onChange={(event) => set('ssl', event.target.checked)}
              />
              SSL-подключение
            </label>

            {testMessage && (
              <div className={`banner ${testMessage.ok ? 'ok' : 'error'}`}>{testMessage.text}</div>
            )}

            <div className="dialog-actions">
              {connections.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setMode('list');
                    setError(null);
                    setTestMessage(null);
                  }}
                >
                  Назад
                </button>
              )}
              <button type="button" onClick={() => void test()} disabled={busy}>
                Проверить
              </button>
              <button type="button" onClick={() => void save(false)} disabled={busy}>
                Сохранить
              </button>
              <button type="submit" className="primary" disabled={busy}>
                Сохранить и подключить
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
