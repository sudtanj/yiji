import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Grid } from './db';
import './grid.css';
import { visibleRange } from './paging';
import { errMsg } from './util';

// ponytail: drivers return the whole result; only the first MAX_ROWS are kept in memory.
const MAX_ROWS = 10_000;
const OVERSCAN = 8;
const DEFAULT_ROW_H = 24;
const CHAR_W = 7.5;
const MIN_COL_W = 60;
const MAX_COL_W = 400;
const SAMPLE_ROWS = 100;

export type Result =
  | { state: 'idle' }
  | { state: 'busy' }
  | { state: 'ok'; grid: Grid; ms: number; total?: number }
  | { state: 'error'; message: string };

export function useQuery(): [Result, (fn: () => Promise<Grid>) => Promise<void>] {
  const [result, setResult] = useState<Result>({ state: 'idle' });
  const latest = useRef(0);
  const run = async (fn: () => Promise<Grid>) => {
    const mine = ++latest.current;
    setResult({ state: 'busy' });
    const t0 = performance.now();
    try {
      const full = await fn();
      const ms = Math.round(performance.now() - t0);
      const over = full.rows.length > MAX_ROWS;
      const grid = over ? { ...full, rows: full.rows.slice(0, MAX_ROWS) } : full;
      if (mine === latest.current) setResult({ state: 'ok', grid, ms, total: over ? full.rows.length : undefined });
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

/** Fixed per-column widths from the header and the first rows, so they do not change while scrolling. */
function columnWidths(grid: Grid): number[] {
  const sample = grid.rows.slice(0, SAMPLE_ROWS);
  return grid.columns.map((c, i) => {
    let chars = c.name.length;
    for (const row of sample) if (row[i] != null) chars = Math.max(chars, fmt(row[i]).length);
    return Math.min(MAX_COL_W, Math.max(MIN_COL_W, Math.round(chars * CHAR_W) + 16));
  });
}

function GridView({ grid }: { grid: Grid }) {
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, height: 0, rowH: DEFAULT_ROW_H });
  const widths = useMemo(() => columnWidths(grid), [grid]);

  // Scroll position is snapped to whole rows so the grid only re-renders when the first row changes.
  const sync = () => {
    const el = box.current!;
    const rowH = parseFloat(getComputedStyle(el).getPropertyValue('--row-h')) || DEFAULT_ROW_H;
    const top = Math.floor(el.scrollTop / rowH) * rowH;
    const height = el.clientHeight;
    setView((v) => (v.top === top && v.height === height && v.rowH === rowH ? v : { top, height, rowH }));
  };
  useEffect(() => {
    const ro = new ResizeObserver(sync);
    ro.observe(box.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    box.current!.scrollTop = 0;
    sync();
  }, [grid]);

  const { rows, columns } = grid;
  const { rowH } = view;
  const [from, to] = visibleRange(view.top, view.height, rowH, OVERSCAN, rows.length);
  const rnW = Math.max(40, String(rows.length).length * 8 + 16);
  const width = widths.reduce((a, b) => a + b, rnW);

  return (
    <div class="vgrid" ref={box} onScroll={sync} tabIndex={0} role="grid" aria-label="Results" aria-rowcount={rows.length + 1} aria-colcount={columns.length + 1}>
      <div class="vg-head" role="row" aria-rowindex={1} style={{ width }}>
        <div class="vg-cell vg-rn" role="columnheader" aria-label="Row" style={{ width: rnW }} />
        {columns.map((c, j) => (
          <div class="vg-cell" role="columnheader" title={c.type ? `${c.name} (${c.type})` : c.name} style={{ width: widths[j] }}>
            {c.name}
          </div>
        ))}
      </div>
      <div class="vg-body" style={{ height: rows.length * rowH, width }}>
        {rows.slice(from, to).map((row, k) => {
          const i = from + k;
          return (
            <div class="vg-row" role="row" aria-rowindex={i + 2} style={{ top: i * rowH, width }}>
              <div class="vg-cell vg-rn" role="gridcell" style={{ width: rnW }}>
                {i + 1}
              </div>
              {row.map((v, j) => {
                if (v === null || v === undefined)
                  return (
                    <div class="vg-cell vg-null" role="gridcell" style={{ width: widths[j] }}>
                      [NULL]
                    </div>
                  );
                const s = fmt(v);
                return (
                  <div class="vg-cell" role="gridcell" title={s.length * CHAR_W > widths[j] - 16 ? s : undefined} style={{ width: widths[j] }}>
                    {s}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
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
  return r.total ? `${grid.rows.length} of ${r.total} rows - ${ms}ms` : `${grid.rows.length} row(s) fetched - ${ms}ms`;
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
