const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 600_000;
const VAULT_ID = '_vault';
const CHECK = 'yiji-vault';

export interface Row {
  id: string;
  data: string;
  updated_at: number;
}

export interface Backend {
  list(): Promise<Row[]>;
  put(row: Row): Promise<void>;
  remove(id: string): Promise<void>;
}

type Bytes = Uint8Array<ArrayBuffer>;
const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Bytes => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function seal(key: CryptoKey, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function open<T>(key: CryptoKey, blob: string): Promise<T> {
  const [iv, ct] = blob.split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(ct));
  return JSON.parse(dec.decode(plain));
}

export const hasVault = async (backend: Backend) => (await backend.list()).some((r) => r.id === VAULT_ID);

/**
 * Encrypted record store. A reserved row holds the PBKDF2 salt, iteration count and an
 * encrypted check value, so the same master password works from any browser using the same backend.
 */
export class Vault<T extends { id: string }> {
  private constructor(
    private backend: Backend,
    private key: CryptoKey,
  ) {}

  /** Creates the vault with `password` on first use, otherwise verifies it. */
  static async unlock<T extends { id: string }>(backend: Backend, password: string, iterations = ITERATIONS) {
    const meta = (await backend.list()).find((r) => r.id === VAULT_ID);
    if (!meta) {
      const salt = crypto.getRandomValues(new Uint8Array(16));
      const key = await deriveKey(password, salt, iterations);
      const data = JSON.stringify({ iterations, salt: b64(salt), check: await seal(key, CHECK) });
      await backend.put({ id: VAULT_ID, data, updated_at: Date.now() });
      return new Vault<T>(backend, key);
    }
    const m = JSON.parse(meta.data);
    const key = await deriveKey(password, unb64(m.salt), m.iterations);
    try {
      await open(key, m.check);
    } catch {
      throw new Error('Wrong master password');
    }
    return new Vault<T>(backend, key);
  }

  async list(): Promise<T[]> {
    const rows = (await this.backend.list()).filter((r) => r.id !== VAULT_ID);
    return Promise.all(rows.map((r) => open<T>(this.key, r.data)));
  }

  async save(item: T): Promise<void> {
    await this.backend.put({ id: item.id, data: await seal(this.key, item), updated_at: Date.now() });
  }

  remove(id: string): Promise<void> {
    return this.backend.remove(id);
  }
}
