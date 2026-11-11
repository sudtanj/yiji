import { bench, describe } from 'vitest';
import { replyToGrid } from './mongo';
import { type Backend, type Row, Vault } from './store';

const memory = (): Backend => {
  const rows = new Map<string, Row>();
  return {
    list: async () => [...rows.values()],
    put: async (r) => void rows.set(r.id, r),
    create: async (r) => void (rows.has(r.id) || rows.set(r.id, r)),
    remove: async (id) => void rows.delete(id),
  };
};

const PW = 'bench-master-password';
const records = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: `conn ${i}`, password: 'x'.repeat(32) }));
const reply = JSON.stringify({
  cursor: { firstBatch: Array.from({ length: 200 }, (_, i) => ({ _id: i, name: `n${i}`, tags: ['a', 'b'], n: { k: i } })) },
  ok: 1,
});

describe('vault', async () => {
  const backend = memory();
  const vault = await Vault.unlock<(typeof records)[number]>(backend, PW);
  for (const r of records) await vault.save(r);

  // Real PBKDF2 cost: 600k iterations.
  bench('unlock (PBKDF2)', async () => void (await Vault.unlock(backend, PW)), { iterations: 3, warmupIterations: 0, time: 0 });
  bench('encrypt 100 records', async () => {
    for (const r of records) await vault.save(r);
  });
  bench('decrypt 100 records', async () => void (await vault.list()));
});

describe('grid', () => {
  bench('replyToGrid, 200 documents', () => void replyToGrid(reply));
});
