import { createClient } from '@libsql/client/web';
import { replyToGrid } from './mongo';
import { withTimeout } from './util';

export type Kind = 'postgres' | 'mongo' | 'sqlite';

export interface ConnConfig {
  id: string;
  name: string;
  kind: Kind;
  host: string;
  port: number;
  database: string;
  /** MongoDB: default database for commands; empty means the auth database. */
  mongoDb?: string;
  user: string;
  password: string;
  relayUrl: string;
  relayToken: string;
  sqliteMode: 'file' | 'remote';
  url: string;
  authToken: string;
}

export interface Grid {
  columns: { name: string; type?: string }[];
  rows: unknown[][];
  rowsAffected?: number | null;
}

/** What a table or collection tab shows. `db` is set for MongoDB only. */
export interface Target {
  schema?: string;
  db?: string;
  name: string;
}

export type IconName = 'db' | 'schema' | 'folder' | 'table' | 'view' | 'collection';

export interface Item {
  label: string;
  icon: IconName;
  open?: Target;
  kids?: () => Promise<Item[]>;
}

export interface Session {
  run(text: string): Promise<Grid>;
  roots(): Promise<Item[]>;
  /** Absent for MongoDB, which has no column metadata. */
  columns?(t: Target): Promise<Grid>;
  rows(t: Target): Promise<Grid>;
  close(): void;
  /** Local SQLite only: downloads the in-memory database. */
  save?(): void;
  /** Local SQLite only: true while there are changes not yet downloaded. */
  dirty?(): boolean;
}

const CONNECT_TIMEOUT = 15_000;
const QUERY_TIMEOUT = 60_000;

/** Times out a connect; if it still completes later, the late connection is closed. */
function guarded<T extends { close(): void }>(attempt: Promise<T>): Promise<T> {
  return withTimeout(attempt, CONNECT_TIMEOUT, 'Connect').catch((e) => {
    attempt.then((c) => c.close(), () => {});
    throw e;
  });
}

const ROW_LIMIT = 200;

export const notConnected = () => new Error('Not connected. Select the connection and click Connect.');

let wasmReady: Promise<typeof import('yiji-wasm')> | undefined;
const wasm = () =>
  (wasmReady ??= import('yiji-wasm')
    .then(async (m) => {
      await m.default();
      return m;
    })
    .catch((e) => {
      wasmReady = undefined;
      throw e;
    }));

// Must be called from a user gesture, before any await.
function pickFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
}

const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

function sqlSession(
  dialect: 'pg' | 'sqlite',
  label: string,
  exec: (sql: string) => Promise<Grid>,
  close: () => void,
  save?: () => void,
  dirty?: () => boolean,
): Session {
  const names = async (sql: string) => (await exec(sql)).rows.map((r) => String(r[0]));
  const pg = dialect === 'pg';

  const tables = (schema: string | undefined, view: boolean) => async (): Promise<Item[]> => {
    const sql = pg
      ? `select table_name from information_schema.tables where table_schema = ${lit(schema!)} and table_type ${view ? '=' : '<>'} 'VIEW' order by 1`
      : `select name from sqlite_master where type = '${view ? 'view' : 'table'}' and name not like 'sqlite\\_%' escape '\\' order by 1`;
    return (await names(sql)).map((name): Item => ({
      label: name,
      icon: view ? 'view' : 'table',
      open: { schema, name },
    }));
  };
  const folders = (schema?: string): Item[] => [
    { label: 'Tables', icon: 'folder', kids: tables(schema, false) },
    { label: 'Views', icon: 'folder', kids: tables(schema, true) },
  ];

  return {
    run: exec,
    close,
    save,
    dirty,
    roots: async () =>
      pg
        ? [
            {
              label: label || 'postgres',
              icon: 'db',
              kids: async () =>
                (
                  await names(
                    "select schema_name from information_schema.schemata where schema_name <> 'information_schema' and schema_name not like 'pg\\_%' order by 1",
                  )
                ).map((s): Item => ({ label: s, icon: 'schema', kids: async () => folders(s) })),
            },
          ]
        : folders(),
    columns: (t) =>
      exec(
        pg
          ? `select column_name as "Name", data_type as "Type", is_nullable as "Nullable" from information_schema.columns where table_schema = ${lit(t.schema!)} and table_name = ${lit(t.name)} order by ordinal_position`
          : `select name as "Name", type as "Type", case "notnull" when 0 then 'YES' else 'NO' end as "Nullable" from pragma_table_info(${lit(t.name)})`,
      ),
    rows: (t) => exec(`select * from ${t.schema ? `${ident(t.schema)}.` : ''}${ident(t.name)} limit ${ROW_LIMIT}`),
  };
}

async function connectPg(cfg: ConnConfig): Promise<Session> {
  const w = await wasm();
  const conn = await guarded(
    w.PgConn.connect(cfg.relayUrl, cfg.relayToken, cfg.host, cfg.port, cfg.user, cfg.password, cfg.database),
  );
  return sqlSession(
    'pg',
    cfg.database,
    async (sql) => JSON.parse(await withTimeout(conn.query(sql), QUERY_TIMEOUT, 'Query')),
    () => conn.close(),
  );
}

async function connectMongo(cfg: ConnConfig): Promise<Session> {
  const w = await wasm();
  const authDb = cfg.database || 'admin';
  const defaultDb = cfg.mongoDb || authDb;
  const conn = await guarded(
    w.MongoConn.connect(cfg.relayUrl, cfg.relayToken, cfg.host, cfg.port, cfg.user, cfg.password, authDb),
  );
  const command = (db: string, doc: string) => withTimeout(conn.runCommand(db, doc), QUERY_TIMEOUT, 'Command');
  const collections = (db: string) => async (): Promise<Item[]> => {
    const reply = JSON.parse(await command(db, '{"listCollections":1,"nameOnly":true}'));
    return (reply.cursor.firstBatch as { name: string }[]).map((c): Item => ({
      label: c.name,
      icon: 'collection',
      open: { db, name: c.name },
    }));
  };
  return {
    run: async (text) => {
      // ponytail: only re-serialised when "$db" is present, since JSON.parse loses int64 precision.
      if (!/"\$db"\s*:/.test(text)) return replyToGrid(await command(defaultDb, text));
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Command must be a JSON object');
      const { $db, ...cmd } = parsed as Record<string, unknown>;
      if ($db === undefined) return replyToGrid(await command(defaultDb, text));
      if (typeof $db !== 'string') throw new Error('"$db" must be a string');
      return replyToGrid(await command($db, JSON.stringify(cmd)));
    },
    close: () => conn.close(),
    roots: async () => {
      const reply = JSON.parse(await command('admin', '{"listDatabases":1,"nameOnly":true}'));
      return (reply.databases as { name: string }[]).map((d): Item => ({ label: d.name, icon: 'db', kids: collections(d.name) }));
    },
    rows: async (t) =>
      replyToGrid(await command(t.db!, JSON.stringify({ find: t.name, limit: ROW_LIMIT, batchSize: ROW_LIMIT }))),
  };
}

async function connectLocal(cfg: ConnConfig): Promise<Session> {
  const file = await pickFile();
  if (!file) throw new Error('No file selected');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { default: init } = await import('@sqlite.org/sqlite-wasm');
  const sqlite3 = await init();
  const db = new sqlite3.oo1.DB();
  const buf = sqlite3.wasm.allocFromTypedArray(bytes);
  const { capi } = sqlite3;
  db.checkRc(
    capi.sqlite3_deserialize(
      db.pointer!,
      'main',
      buf,
      bytes.length,
      bytes.length,
      capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE,
    ),
  );
  const exec = async (sql: string): Promise<Grid> => {
    const columnNames: string[] = [];
    const rows = db.exec({ sql, rowMode: 'array', returnValue: 'resultRows', columnNames });
    return {
      columns: columnNames.map((name) => ({ name })),
      rows,
      rowsAffected: columnNames.length ? null : db.changes(),
    };
  };
  // Fail now on a file that is not a database.
  try {
    await exec('select 1 from sqlite_master limit 1');
  } catch (e) {
    db.close();
    throw e;
  }
  // total_changes misses DDL, so the schema cookie is part of the fingerprint.
  const fingerprint = () => `${db.changes(true)}:${db.selectValue('pragma schema_version')}`;
  let saved = fingerprint();
  const save = () => {
    const url = URL.createObjectURL(new Blob([capi.sqlite3_js_db_export(db.pointer!).slice()], { type: 'application/vnd.sqlite3' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = file.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    saved = fingerprint();
  };
  return sqlSession('sqlite', cfg.name, exec, () => db.close(), save, () => fingerprint() !== saved);
}

async function connectRemote(cfg: ConnConfig): Promise<Session> {
  const client = createClient({ url: cfg.url, authToken: cfg.authToken });
  const exec = async (sql: string): Promise<Grid> => {
    const rs = await withTimeout(client.execute(sql), QUERY_TIMEOUT, 'Query');
    return {
      columns: rs.columns.map((name, i) => ({ name, type: rs.columnTypes[i] || undefined })),
      rows: rs.rows.map((r) => rs.columns.map((_, i) => r[i])),
      rowsAffected: rs.columns.length ? null : rs.rowsAffected,
    };
  };
  try {
    await exec('select 1');
  } catch (e) {
    client.close();
    throw e;
  }
  return sqlSession('sqlite', cfg.name, exec, () => client.close());
}

export function connect(cfg: ConnConfig): Promise<Session> {
  if (cfg.kind === 'postgres') return connectPg(cfg);
  if (cfg.kind === 'mongo') return connectMongo(cfg);
  return cfg.sqliteMode === 'remote' ? connectRemote(cfg) : connectLocal(cfg);
}
