import { useRef, useState } from 'preact/hooks';
import type { Grid } from './db';
import { errMsg } from './util';

// ponytail: the whole result is fetched; only rendering is capped, to keep the DOM small.
const MAX_ROWS = 1000;

export type Result =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; grid: Grid; ms: number }
  | { state: 'error'; message: string };

export function useQuery(): [Result, (fn: () => Promise<Grid>) => Promise<void>] {
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const latest = useRef(0);
  const run = async (fn: () => Promise<Grid>) => {
    const mine = ++latest.current;
    setResult({ state: 'busy' });
    const t0 = performance.now();
    try {
      const grid = await fn();
      if (mine === latest.current) setResult({ state: 'ok', grid, ms: Math.round(performance.now() - t0) });
    } catch (e) {
      if (mine === latest.current) setResult({ state: 'error', message: errMsg(e) });
    }
  };
  return [result, run];
}

function fmt(v: unknown): string {
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return `[BLOB ${v.byteLength} bytes]`;
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

function GridView({ grid }: { grid: Grid }) {
  return (
    <div class="grid-scroll">
      <table class="grid">
        <thead>
          <tr>
            <th class="rn" />
            {grid.columns.map((c) => (
              <th title={c.type}>{c.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.rows.slice(0, MAX_ROWS).map((row, i) => (
            <tr>
              <td class="rn">{i + 1}</td>
              {row.map((v) =>
                v === null || v === undefined ? <td class="null">[NULL]</td> : <td>{fmt(v)}</td>,
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function footer(r: Result): string {
  if (r.state === 'busy') return 'Executing...';
  if (r.state === 'error') return 'Error';
  if (r.state !== 'ok') return '';
  const { grid, ms } = r;
  if (!grid.columns.length) {
    return grid.rowsAffected == null ? `Statement executed - ${ms}ms` : `${grid.rowsAffected} row(s) affected - ${ms}ms`;
  }
  const n = grid.rows.length;
  return n > MAX_ROWS ? `${MAX_ROWS} of ${n} rows shown - ${ms}ms` : `${n} row(s) fetched - ${ms}ms`;
}

export function ResultPane({ result, idle }: { result: Result; idle: string }) {
  return (
    <div class="results">
      <div class="subtabs" role="tablist">
        <span class="subtab active" role="tab" aria-selected="true">
          Results
        </span>
      </div>
      <div class="results-body" aria-busy={result.state === 'busy'}>
        {result.state === 'idle' && <p class="note">{idle}</p>}
        {result.state === 'error' && (
          <p class="note error" role="alert">
            {result.message}
          </p>
        )}
        {result.state === 'ok' &&
          (result.grid.columns.length ? (
            <GridView grid={result.grid} />
          ) : (
            <p class="note">Statement executed. No rows returned.</p>
          ))}
      </div>
      <div class="footer" role="status">
        {footer(result)}
      </div>
    </div>
  );
}

export function GridPane({ result, name }: { result: Result; name: string }) {
  return result.state === 'ok' ? (
    <GridView grid={result.grid} />
  ) : (
    <p class={`note${result.state === 'error' ? ' error' : ''}`} role={result.state === 'error' ? 'alert' : undefined}>
      {result.state === 'error' ? result.message : `Loading ${name}...`}
    </p>
  );
}
