import type { Grid } from './db';

/** Maps a MongoDB reply (relaxed Extended JSON) to a grid: cursor.firstBatch if present, else the raw reply. */
export function replyToGrid(json: string): Grid {
  const reply = JSON.parse(json);
  if (reply.ok === 0) throw new Error(reply.errmsg ?? 'Command failed');
  const batch: Record<string, unknown>[] | undefined = reply.cursor?.firstBatch;
  if (!Array.isArray(batch)) return { columns: [{ name: 'reply' }], rows: [[JSON.stringify(reply)]] };

  const keys = new Set<string>();
  for (const doc of batch) for (const k of Object.keys(doc)) keys.add(k);
  const names = [...keys];
  const cell = (v: unknown) => (v === undefined ? null : typeof v === 'object' && v !== null ? JSON.stringify(v) : v);
  return { columns: names.map((name) => ({ name })), rows: batch.map((doc) => names.map((k) => cell(doc[k]))) };
}
