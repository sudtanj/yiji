const enc = new TextEncoder();
const dec = new TextDecoder();
const ITERATIONS = 600_000;
const MAX_ITERATIONS = 5_000_000;
const SALT_BYTES = 16;
const MIN_PASSWORD = 10;
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
  /** Inserts only if no row with this id exists; never overwrites. */
  create(row: Row): Promise<void>;
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

// The row id is authenticated data, so a ciphertext copied to another row id fails to decrypt.
async function seal(key: CryptoKey, id: string, value: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: enc.encode(id) },
    key,
    enc.encode(JSON.stringify(value)),
  );
  return `${b64(iv)}.${b64(new Uint8Array(ct))}`;
}

async function open<T>(key: CryptoKey, id: string, blob: string): Promise<T> {
  const [iv, ct] = blob.split('.');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(iv), additionalData: enc.encode(id) },
    key,
    unb64(ct),
  );
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
    const rows = await backend.list();
    let meta = rows.find((r) => r.id === VAULT_ID);
    if (!meta) {
      if (rows.length) throw new Error('This store has connections but no vault record. Refusing to create a new vault over them.');
      if (password.length < MIN_PASSWORD) throw new Error(`Master password must be at least ${MIN_PASSWORD} characters.`);
      const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
      const key = await deriveKey(password, salt, iterations);
      const row = {
        id: VAULT_ID,
        data: JSON.stringify({ iterations, salt: b64(salt), check: await seal(key, VAULT_ID, CHECK) }),
        updated_at: Date.now(),
      };
      await backend.create(row);
      meta = (await backend.list()).find((r) => r.id === VAULT_ID);
      if (!meta) throw new Error('Could not create the vault record.');
      // Someone else may have created it first; then the stored salt wins.
      if (meta.data === row.data) return new Vault<T>(backend, key);
    }
    try {
      const m = JSON.parse(meta.data);
      const salt = unb64(m.salt);
      if (!Number.isInteger(m.iterations) || m.iterations < ITERATIONS || m.iterations > MAX_ITERATIONS || salt.length !== SALT_BYTES) {
        throw new Error('invalid vault parameters');
      }
      const key = await deriveKey(password, salt, m.iterations);
      await open(key, VAULT_ID, m.check);
      return new Vault<T>(backend, key);
    } catch {
      throw new Error('Wrong master password, or the vault record is damaged.');
    }
  }

  /** Records that fail to decrypt are skipped and counted, so one bad row does not hide the rest. */
  async list(): Promise<{ items: T[]; failed: number }> {
    const rows = (await this.backend.list()).filter((r) => r.id !== VAULT_ID);
    const settled = await Promise.allSettled(
      rows.map(async (r) => {
        const item = await open<T>(this.key, r.id, r.data);
        if (item.id !== r.id) throw new Error('record id mismatch');
        return item;
      }),
    );
    const items = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
    return { items, failed: rows.length - items.length };
  }

  async save(item: T): Promise<void> {
    await this.backend.put({ id: item.id, data: await seal(this.key, item.id, item), updated_at: Date.now() });
  }

  remove(id: string): Promise<void> {
    return this.backend.remove(id);
  }
}
