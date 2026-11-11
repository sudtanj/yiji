import { describe, expect, it } from 'vitest';
import { type Backend, type Row, Vault, hasVault } from './store';

const memory = (): Backend & { rows: Map<string, Row> } => {
  const rows = new Map<string, Row>();
  return {
    rows,
    list: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    remove: async (id) => void rows.delete(id),
  };
};

const ITER = 1000;
const conn = { id: 'c1', name: 'prod', password: 'hunter2-db-secret', relayToken: 'tok-123' };

describe('Vault', () => {
  it('round-trips a record and stores only ciphertext', async () => {
    const backend = memory();
    const vault = await Vault.unlock<typeof conn>(backend, 'master-pw', ITER);
    await vault.save(conn);

    const stored = backend.rows.get('c1')!;
    expect(stored.data).not.toContain('hunter2');
    expect(stored.data).not.toContain('prod');

    const reopened = await Vault.unlock<typeof conn>(backend, 'master-pw', ITER);
    expect(await reopened.list()).toEqual([conn]);
  });

  it('rejects a wrong master password', async () => {
    const backend = memory();
    await Vault.unlock(backend, 'master-pw', ITER);
    await expect(Vault.unlock(backend, 'other-pw', ITER)).rejects.toThrow('Wrong master password');
  });

  it('uses a fresh IV for each save of the same record', async () => {
    const backend = memory();
    const vault = await Vault.unlock<typeof conn>(backend, 'master-pw', ITER);
    await vault.save(conn);
    const first = backend.rows.get('c1')!.data;
    await vault.save(conn);
    expect(backend.rows.get('c1')!.data).not.toBe(first);
  });

  it('removes records and reports whether a vault exists', async () => {
    const backend = memory();
    expect(await hasVault(backend)).toBe(false);
    const vault = await Vault.unlock<typeof conn>(backend, 'master-pw', ITER);
    expect(await hasVault(backend)).toBe(true);
    await vault.save(conn);
    await vault.remove('c1');
    expect(await vault.list()).toEqual([]);
  });
});
