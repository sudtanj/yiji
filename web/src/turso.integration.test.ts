import { beforeEach, describe, expect, it } from 'vitest';
import { makeBackend } from './backends';
import { type ConnConfig, connect } from './db';
import { Vault, hasVault } from './store';

const url = process.env.YIJI_LIBSQL_URL;
const PW = 'ci-master-password';

interface Rec {
  id: string;
  name: string;
  password: string;
}
const prod: Rec = { id: 'c1', name: 'prod', password: 'hunter2-db-secret' };
const staging: Rec = { id: 'c2', name: 'staging', password: 'other-db-secret' };
const byId = (items: Rec[]) => [...items].sort((a, b) => a.id.localeCompare(b.id));

describe.skipIf(!url)('libSQL server', () => {
  const backend = () => makeBackend({ url: url!, token: '' });

  beforeEach(async () => {
    const b = backend();
    for (const r of await b.list()) await b.remove(r.id);
  });

  it('creates a vault, saves, lists, upserts and deletes records', async () => {
    const b = backend();
    expect(await hasVault(b)).toBe(false);
    const vault = await Vault.unlock<Rec>(b, PW);
    expect(await hasVault(b)).toBe(true);

    await vault.save(prod);
    await vault.save(staging);
    const { items, failed } = await vault.list();
    expect(byId(items)).toEqual([prod, staging]);
    expect(failed).toBe(0);

    const stored = (await b.list()).find((r) => r.id === 'c2')!;
    expect(stored.data).not.toContain('other-db-secret');

    await vault.save({ ...prod, name: 'prod-renamed' });
    expect(byId((await vault.list()).items)).toEqual([{ ...prod, name: 'prod-renamed' }, staging]);
    expect((await b.list()).filter((r) => r.id === 'c1')).toHaveLength(1);

    await vault.remove('c1');
    expect((await vault.list()).items).toEqual([staging]);
  });

  it('opens the same vault from a second instance with the same password', async () => {
    const first = await Vault.unlock<Rec>(backend(), PW);
    await first.save(prod);

    const second = await Vault.unlock<Rec>(backend(), PW);
    expect((await second.list()).items).toEqual([prod]);
    await second.save(staging);
    expect(byId((await first.list()).items)).toEqual([prod, staging]);
  });

  it('rejects a wrong master password', async () => {
    await Vault.unlock<Rec>(backend(), PW);
    await expect(Vault.unlock<Rec>(backend(), 'another-password')).rejects.toThrow('Wrong master password');
  });

  it('create never overwrites an existing row', async () => {
    const b = backend();
    const vault = await Vault.unlock<Rec>(b, PW);
    await vault.save(prod);
    const before = await b.list();

    await b.create({ id: '_vault', data: 'overwritten', updated_at: 0 });
    await b.create({ id: 'c1', data: 'overwritten', updated_at: 0 });
    expect(await b.list()).toEqual(before);
    expect((await (await Vault.unlock<Rec>(b, PW)).list()).items).toEqual([prod]);
  });

  it('runs queries against a remote SQLite database', async () => {
    const cfg = { kind: 'sqlite', sqliteMode: 'remote', url: url!, authToken: '', name: 'ci' } as ConnConfig;
    const session = await connect(cfg);
    const table = `ci_${Date.now()}`;
    try {
      await session.run(`create table ${table} (id integer primary key, name text, score real)`);
      const insert = await session.run(`insert into ${table} values (1, 'a', 1.5), (2, 'b', null)`);
      expect(insert.rowsAffected).toBe(2);

      const grid = await session.run(`select id, name, score from ${table} order by id`);
      expect(grid.columns.map((c) => c.name)).toEqual(['id', 'name', 'score']);
      expect(grid.rows).toEqual([
        [1, 'a', 1.5],
        [2, 'b', null],
      ]);
      expect(grid.rowsAffected).toBeNull();

      const [tables] = await session.roots();
      expect((await tables.kids!()).map((i) => i.label)).toContain(table);
      expect((await session.rows({ name: table })).rows).toHaveLength(2);

      await expect(session.run('select * from no_such_table')).rejects.toThrow();
    } finally {
      await session.run(`drop table ${table}`);
      session.close();
    }
  });
});
