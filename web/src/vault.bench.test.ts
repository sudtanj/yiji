// ponytail: plain timing instead of `vitest bench` (gone from the vitest 5 exports); switch back to a bench API if one returns.
import { describe, expect, it } from 'vitest';
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

const time = async (label: string, runs: number, fn: () => unknown) => {
  const t0 = performance.now();
  for (let i = 0; i < runs; i++) await fn();
  const ms = (performance.now() - t0) / runs;
  console.log(`BENCH ${label}: ${ms.toFixed(2)} ms/op (${runs} runs)`);
  return ms;
};

const PW = 'bench-master-password';
const records = Array.from({ length: 100 }, (_, i) => ({ id: `c${i}`, name: `conn ${i}`, password: 'x'.repeat(32) }));
const reply = JSON.stringify({
  cursor: { firstBatch: Array.from({ length: 200 }, (_, i) => ({ _id: i, name: `n${i}`, tags: ['a', 'b'], n: { k: i } })) },
  ok: 1,
});

describe.skipIf(!process.env.YIJI_BENCH)('bench', () => {
  it('vault and grid', async () => {
    const backend = memory();
    const vault = await Vault.unlock<(typeof records)[number]>(backend, PW);
    await time('unlock (PBKDF2 600k)', 3, () => Vault.unlock(backend, PW));
    await time('encrypt 100 records', 5, async () => {
      for (const r of records) await vault.save(r);
    });
    await time('decrypt 100 records', 5, () => vault.list());
    expect(await time('replyToGrid, 200 documents', 50, () => replyToGrid(reply))).toBeGreaterThan(0);
  });
});
