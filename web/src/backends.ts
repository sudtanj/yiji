import { createClient } from '@libsql/client/web';
import type { Backend, Row } from './store';
import { withTimeout } from './util';

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
export const loadSettings = (): TursoSettings | null => JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');

export function saveSettings(s: TursoSettings | null) {
  if (s) localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  else localStorage.removeItem(SETTINGS_KEY);
}

function localBackend(): Backend {
  const read = (): Row[] => JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '[]');
  const write = (rows: Row[]) => localStorage.setItem(LOCAL_KEY, JSON.stringify(rows));
  return {
    list: async () => read(),
    put: async (row) => write([...read().filter((r) => r.id !== row.id), row]),
    remove: async (id) => write(read().filter((r) => r.id !== id)),
  };
}

function tursoBackend({ url, token }: TursoSettings): Backend {
  const client = createClient({ url, authToken: token });
  let ready: Promise<unknown> | undefined;
  const run = async (sql: string, args: (string | number)[] = []) => {
    ready ??= withTimeout(
      client.execute(
        'CREATE TABLE IF NOT EXISTS connections (id TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      ),
      TURSO_TIMEOUT,
      'Turso',
    );
    await ready;
    return withTimeout(client.execute({ sql, args }), TURSO_TIMEOUT, 'Turso');
  };
  return {
    list: async () =>
      (await run('SELECT id, data, updated_at FROM connections')).rows.map((r) => ({
        id: String(r.id),
        data: String(r.data),
        updated_at: Number(r.updated_at),
      })),
    put: async (row) => {
      await run('INSERT OR REPLACE INTO connections (id, data, updated_at) VALUES (?, ?, ?)', [
        row.id,
        row.data,
        row.updated_at,
      ]);
    },
    remove: async (id) => {
      await run('DELETE FROM connections WHERE id = ?', [id]);
    },
  };
}

export const makeBackend = (s: TursoSettings | null): Backend => (s ? tursoBackend(s) : localBackend());
