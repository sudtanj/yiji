import { createClient } from '@libsql/client/web';
import type { Backend, Row } from './store';
import { retryable, withTimeout } from './util';

export interface TursoSettings {
  url: string;
  token: string;
}

const SETTINGS_KEY = 'yiji.turso';
const LOCAL_KEY = 'yiji.connections';
const TURSO_TIMEOUT = 15_000;

// ponytail: the Turso URL and token sit in localStorage in clear text because they are needed
// before the master password can be checked (the salt itself lives in Turso). The connection
// records stay encrypted; the token only grants access to those ciphertexts.
// ponytail: unreadable stored settings count as "none" so the app can still start.
export function loadSettings(): TursoSettings | null {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
  } catch {
    return null;
  }
}

export const hasStoredSettings = () => localStorage.getItem(SETTINGS_KEY) !== null;

export function clearSettings() {
  localStorage.removeItem(SETTINGS_KEY);
}

/** Returns an error message, or null when `url` can be saved. The token may be empty (sqld without auth). */
export function checkSettings(url: string): string | null {
  return /^(https|libsql):\/\/./.test(url) ? null : 'The URL must start with https:// or libsql://.';
}

export const saveSettings = (s: TursoSettings) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

function localBackend(): Backend {
  const read = (): Row[] => JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
  const write = (rows: Row[]) => localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  return {
    list: async () => read(),
    put: async (row) => write([...read().filter((r) => r.id !== row.id), row]),
    create: async (row) => {
      const rows = read();
      if (!rows.some((r) => r.id === row.id)) write([...rows, row]);
    },
    remove: async (id) => write(read().filter((r) => r.id !== id)),
  };
}

function tursoBackend({ url, token }: TursoSettings): Backend {
  const client = createClient({ url, authToken: token || undefined });
  const ready = retryable(() =>
    withTimeout(
      client.execute(
        'CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      ),
      TURSO_TIMEOUT,
      'Turso',
    ),
  );
  const run = async (sql: string, args: (string | number)[] = []) => {
    await ready();
    return withTimeout(client.execute({ sql, args }), TURSO_TIMEOUT, 'Turso');
  };
  const insert = 'INSERT INTO connections (id, data, updated_at) VALUES (?, ?, ?)';
  return {
    list: async () =>
      (await run('SELECT id, data, updated_at FROM connections')).rows.map((r) => ({
        id: String(r.id),
        data: String(r.data),
        updated_at: Number(r.updated_at),
      })),
    put: async (row) => {
      await run(`${insert} ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`, [
        row.id,
        row.data,
        row.updated_at,
      ]);
    },
    create: async (row) => {
      await run(`${insert} ON CONFLICT(id) DO NOTHING`, [row.id, row.data, row.updated_at]);
    },
    remove: async (id) => {
      await run('DELETE FROM connections WHERE id = ?', [id]);
    },
  };
}

export const makeBackend = (s: TursoSettings | null): Backend => (s ? tursoBackend(s) : localBackend());
