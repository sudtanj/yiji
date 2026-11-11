import type { ConnConfig } from './db';
import { type Backend, type Row, Vault } from './store';
import { withTimeout } from './util';

export interface RelaySettings {
  url: string;
  password: string;
}

const SETTINGS_KEY = 'yiji.relay';
// Above the relay worst case: lazy CREATE TABLE plus the statement, 15 s each.
const RELAY_TIMEOUT = 35_000;

// ponytail: the relay URL and password sit in localStorage in clear text because the user chose to
// stay logged in on this device. The password also derives the vault key, so anyone who can read
// this browser profile can read the saved connections.
// ponytail: unreadable stored settings count as "none" so the app can still start.
export function loadSettings(): RelaySettings | null {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return typeof s?.url === 'string' && typeof s?.password === 'string' ? s : null;
  } catch {
    return null;
  }
}

export const saveSettings = (s: RelaySettings) => localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

// Also drops keys left by the old in-browser Turso mode.
export const clearSettings = () =>
  [SETTINGS_KEY, 'yiji.turso', 'yiji.connections'].forEach((k) => localStorage.removeItem(k));

/** Returns an error message, or null when `url` is an acceptable relay address. */
export function checkRelayUrl(url: string): string | null {
  const message = 'The relay URL must start with wss:// (ws:// only for localhost).';
  try {
    const u = new URL(url);
    if (u.protocol === 'wss:') return null;
    return u.protocol === 'ws:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1') ? null : message;
  } catch {
    return message;
  }
}

/** One WebSocket per operation: hello, wait for "ok", send the request, read one JSON reply. */
function exchange(url: string, password: string, request: object): Promise<{ rows?: Row[] }> {
  let ws: WebSocket | undefined;
  const reply = new Promise<{ rows?: Row[] }>((resolve, reject) => {
    const socket = (ws = new WebSocket(url));
    let ready = false;
    socket.onopen = () => socket.send(JSON.stringify({ token: password, vault: true }));
    socket.onmessage = (e) => {
      if (!ready) {
        if (e.data !== 'ok') return reject(new Error('Unexpected reply from the relay.'));
        ready = true;
        return socket.send(JSON.stringify(request));
      }
      try {
        const r = JSON.parse(e.data);
        if (r.error) reject(new Error(String(r.error)));
        else resolve(r);
      } catch {
        reject(new Error('Unexpected reply from the relay.'));
      }
    };
    // The close reason is how the relay reports a rejected hello ("bad token", ...).
    socket.onclose = (e) => reject(new Error(e.reason || (ready ? 'The relay closed the connection.' : 'Could not connect to the relay.')));
  });
  return withTimeout(reply, RELAY_TIMEOUT, 'Relay').finally(() => ws?.close());
}

export function relayBackend(url: string, password: string): Backend {
  const call = (request: object) => exchange(url, password, request);
  return {
    list: async () => (await call({ op: 'list' })).rows ?? [],
    put: async (row) => void (await call({ op: 'put', row })),
    create: async (row) => void (await call({ op: 'create', row })),
    remove: async (id) => void (await call({ op: 'remove', id })),
  };
}

/** The relay password doubles as the vault master password. */
export const openVault = ({ url, password }: RelaySettings) =>
  Vault.unlock<ConnConfig>(relayBackend(url, password), password);
