import { describe, expect, it } from 'vitest';
import { type Backend, type Row, Vault, hasVault } from './store';
import { retryable } from './util';

const memory = (): Backend & { rows: Map<string, Row> } => {
  const rows = new Map<string, Row>();
  return {
    rows,
    list: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    create: async (r) => void (rows.has(r.id) || rows.set(r.id, r)),
    remove: async (id) => void rows.delete(id),
  };
};

const PW = 'master-password';
const conn = { id: 'c1', name: 'prod', password: 'hunter2-db-secret', relayToken: 'tok-123' };
const other = { id: 'c2', name: 'staging', password: 'x', relayToken: 'y' };
type Conn = typeof conn;

describe('Vault', () => {
  it('round-trips a record and stores only ciphertext', async () => {
    const backend = memory();
    const vault = await Vault.unlock<Conn>(backend, PW);
    await vault.save(conn);

    const stored = backend.rows.get('c1')!;
    expect(stored.data).not.toContain('hunter2');
    expect(stored.data).not.toContain('prod');

    const reopened = await Vault.unlock<Conn>(backend, PW);
    expect(await reopened.list()).toEqual({ items: [conn], failed: 0 });
  });

  it('rejects a wrong master password', async () => {
    const backend = memory();
    await Vault.unlock(backend, PW);
    await expect(Vault.unlock(backend, 'another-password')).rejects.toThrow('Wrong master password');
  });

  it('rejects a short master password when creating a vault', async () => {
    const backend = memory();
    await expect(Vault.unlock(backend, 'short')).rejects.toThrow('at least 10');
    expect(await hasVault(backend)).toBe(false);
  });

  it('uses a fresh IV for each save of the same record', async () => {
    const backend = memory();
    const vault = await Vault.unlock<Conn>(backend, PW);
    await vault.save(conn);
    const first = backend.rows.get('c1')!.data;
    await vault.save(conn);
    expect(backend.rows.get('c1')!.data).not.toBe(first);
  });

  it('removes records and reports whether a vault exists', async () => {
    const backend = memory();
    expect(await hasVault(backend)).toBe(false);
    const vault = await Vault.unlock<Conn>(backend, PW);
    expect(await hasVault(backend)).toBe(true);
    await vault.save(conn);
    await vault.remove('c1');
    expect(await vault.list()).toEqual({ items: [], failed: 0 });
  });

  it('rejects a record whose ciphertext was moved to another row id', async () => {
    const backend = memory();
    const vault = await Vault.unlock<Conn>(backend, PW);
    await vault.save(conn);
    await vault.save(other);
    backend.rows.set('c2', { ...backend.rows.get('c1')!, id: 'c2' });
    expect(await vault.list()).toEqual({ items: [conn], failed: 1 });
  });

  it('keeps good rows when one row is corrupt', async () => {
    const backend = memory();
    const vault = await Vault.unlock<Conn>(backend, PW);
    await vault.save(conn);
    backend.rows.set('bad', { id: 'bad', data: 'not.valid', updated_at: 0 });
    expect(await vault.list()).toEqual({ items: [conn], failed: 1 });
  });

  it.each([
    ['too few iterations', { iterations: 1000 }],
    ['too many iterations', { iterations: 50_000_000 }],
    ['non-integer iterations', { iterations: 600000.5 }],
    ['a short salt', { salt: btoa('1234567') }],
  ])('rejects a vault record with %s', async (_, patch) => {
    const backend = memory();
    await Vault.unlock(backend, PW);
    const meta = backend.rows.get('_vault')!;
    backend.rows.set('_vault', { ...meta, data: JSON.stringify({ ...JSON.parse(meta.data), ...patch }) });
    await expect(Vault.unlock(backend, PW)).rejects.toThrow('damaged');
  });

  it('does not overwrite an existing vault', async () => {
    const backend = memory();
    const vault = await Vault.unlock<Conn>(backend, PW);
    await vault.save(conn);
    const before = backend.rows.get('_vault')!.data;

    await expect(Vault.unlock(backend, 'a-different-password')).rejects.toThrow();
    expect(backend.rows.get('_vault')!.data).toBe(before);
    expect((await (await Vault.unlock<Conn>(backend, PW)).list()).items).toEqual([conn]);
  });

  it('refuses to create a vault over rows that have none', async () => {
    const backend = memory();
    backend.rows.set('c1', { id: 'c1', data: 'x.y', updated_at: 1 });
    await expect(Vault.unlock(backend, PW)).rejects.toThrow('no vault record');
    expect(backend.rows.has('_vault')).toBe(false);
  });
});

describe('retryable', () => {
  it('retries after a failure and caches the first success', async () => {
    let calls = 0;
    const ready = retryable(async () => {
      if (++calls === 1) throw new Error('offline');
      return 'ok';
    });
    await expect(ready()).rejects.toThrow('offline');
    expect(await ready()).toBe('ok');
    expect(await ready()).toBe('ok');
    expect(calls).toBe(2);
  });
});
