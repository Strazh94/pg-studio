import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ConnectionConfig, ConnectionSummary } from '../../shared/types';

interface StoredConnection {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  /** base64; encrypted=true — зашифровано safeStorage. */
  password: string;
  encrypted: boolean;
}

interface StoreFile {
  version: 1;
  connections: StoredConnection[];
}

let cache: StoreFile | null = null;

function storePath(): string {
  return path.join(app.getPath('userData'), 'connections.json');
}

function load(): StoreFile {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(storePath(), 'utf8');
    const parsed = JSON.parse(raw) as StoreFile;
    if (parsed && Array.isArray(parsed.connections)) {
      cache = parsed;
      return cache;
    }
  } catch {
    // файла ещё нет или он повреждён — начинаем с пустого списка
  }
  cache = { version: 1, connections: [] };
  return cache;
}

function persist(): void {
  const file = storePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(load(), null, 2), { encoding: 'utf8', mode: 0o600 });
}

function encrypt(password: string): { value: string; encrypted: boolean } {
  if (!password) return { value: '', encrypted: false };
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return { value: safeStorage.encryptString(password).toString('base64'), encrypted: true };
    }
  } catch {
    // падаем в незашифрованное хранение ниже
  }
  return { value: password, encrypted: false };
}

function decrypt(value: string, encrypted: boolean): string {
  if (!value) return '';
  if (!encrypted) return value;
  try {
    return safeStorage.decryptString(Buffer.from(value, 'base64'));
  } catch {
    return '';
  }
}

function toSummary(stored: StoredConnection): ConnectionSummary {
  return {
    id: stored.id,
    name: stored.name,
    host: stored.host,
    port: stored.port,
    database: stored.database,
    user: stored.user,
    ssl: stored.ssl,
    hasPassword: Boolean(stored.password),
  };
}

export function listConnections(): ConnectionSummary[] {
  return load().connections.map(toSummary);
}

export function saveConnection(config: ConnectionConfig): SaveResult {
  const store = load();
  const id = config.id && config.id !== 'new' ? config.id : crypto.randomUUID();
  const existing = store.connections.find((item) => item.id === id);

  // Пустой пароль при редактировании = «не менять сохранённый».
  let password: string;
  let encrypted: boolean;
  if (config.password === '' && existing) {
    password = existing.password;
    encrypted = existing.encrypted;
  } else {
    const packed = encrypt(config.password);
    password = packed.value;
    encrypted = packed.encrypted;
  }

  const stored: StoredConnection = {
    id,
    name: config.name.trim() || `${config.host}:${config.port}/${config.database}`,
    host: config.host.trim(),
    port: Number(config.port) || 5432,
    database: config.database.trim(),
    user: config.user.trim(),
    ssl: Boolean(config.ssl),
    password,
    encrypted,
  };

  if (existing) {
    Object.assign(existing, stored);
  } else {
    store.connections.push(stored);
  }
  persist();
  return { id, list: listConnections() };
}

export interface SaveResult {
  id: string;
  list: ConnectionSummary[];
}

export function removeConnection(id: string): ConnectionSummary[] {
  const store = load();
  store.connections = store.connections.filter((item) => item.id !== id);
  persist();
  return listConnections();
}

/** Полная конфигурация (с расшифрованным паролем) для подключения к БД. */
export function getConnection(id: string): ConnectionConfig | undefined {
  const stored = load().connections.find((item) => item.id === id);
  if (!stored) return undefined;
  return {
    id: stored.id,
    name: stored.name,
    host: stored.host,
    port: stored.port,
    database: stored.database,
    user: stored.user,
    password: decrypt(stored.password, stored.encrypted),
    ssl: stored.ssl,
  };
}

/**
 * Конфигурация из диалога: если пароль пуст, а соединение уже сохранено —
 * берём сохранённый пароль (чтобы «Проверить» работал без повторного ввода).
 */
export function resolveConfig(config: ConnectionConfig): ConnectionConfig {
  if (config.password || !config.id || config.id === 'new') return config;
  const stored = getConnection(config.id);
  return stored ? { ...stored, name: config.name || stored.name } : config;
}
