import { json } from '@codemirror/lang-json';
import { PostgreSQL, SQLite, sql } from '@codemirror/lang-sql';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { EditorView, placeholder } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { tags as t } from '@lezer/highlight';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Kind, type Session, type Target, notConnected } from './db';
import { GridPane, ResultPane, footer, useQuery } from './grid';
import { Icon } from './icons';
import { PAGE_SIZE } from './paging';

export const EXECUTE_EVENT = 'yiji:execute';

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword], color: '#53dbc9' },
  { tag: [t.string, t.special(t.string)], color: '#a8d5a2' },
  { tag: [t.number, t.bool, t.null], color: '#f2c078' },
  { tag: t.comment, color: '#8a9591', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.function(t.variableName)], color: '#adcae6' },
  { tag: [t.propertyName, t.attributeName], color: '#9fd0f0' },
]);

const theme = EditorView.theme(
  {
    '&': { height: '100%', fontSize: '13px', color: 'var(--on-surface)', backgroundColor: 'var(--surface-lowest)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)' },
    '.cm-content': { caretColor: 'var(--primary)', padding: '8px 0' },
    '&.cm-focused': { outline: 'none' },
    '.cm-cursor': { borderLeftColor: 'var(--primary)' },
    '.cm-gutters': { backgroundColor: 'var(--surface-lowest)', color: 'var(--outline)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--surface-low)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--surface-low)', color: 'var(--on-surface)' },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: 'var(--secondary-container)',
    },
    '.cm-tooltip': { backgroundColor: 'var(--surface-high)', color: 'var(--on-surface)', border: 'none', borderRadius: '8px', overflow: 'hidden' },
    '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: 'var(--primary-container)', color: 'var(--on-primary-container)' },
    '.cm-panels': { backgroundColor: 'var(--surface-low)', color: 'var(--on-surface)' },
    '.cm-placeholder': { color: 'var(--on-surface-variant)' },
  },
  { dark: true },
);

/** Selection if any; for SQL, otherwise the block of lines around the cursor up to the nearest blank lines. */
function pickStatement(state: EditorState, kind: Kind): string {
  const sel = state.selection.main;
  if (!sel.empty) return state.sliceDoc(sel.from, sel.to);
  if (kind === 'mongo') return state.doc.toString();
  const { doc } = state;
  let a = doc.lineAt(sel.head).number;
  let b = a;
  if (!doc.line(a).text.trim()) return '';
  while (a > 1 && doc.line(a - 1).text.trim()) a--;
  while (b < doc.lines && doc.line(b + 1).text.trim()) b++;
  return doc.sliceString(doc.line(a).from, doc.line(b).to);
}

export function SqlTab({ id, kind, session, active }: { id: string; kind: Kind; session?: Session; active: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | undefined>(undefined);
  const [height, setHeight] = useState(200);
  const [result, run] = useQuery();

  const execute = () => {
    const text = view.current ? pickStatement(view.current.state, kind) : '';
    if (!text.trim()) return;
    run(() => (session ? session.run(text) : Promise.reject(notConnected())));
  };
  const latest = useRef(execute);
  latest.current = execute;

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        extensions: [
          basicSetup,
          theme,
          syntaxHighlighting(highlight),
          kind === 'mongo' ? json() : sql({ dialect: kind === 'postgres' ? PostgreSQL : SQLite }),
          ...(kind === 'mongo' ? [placeholder('{"find":"users","filter":{},"limit":200}')] : []),
        ],
      }),
    });
    view.current = v;
    const onExecute = (e: Event) => (e as CustomEvent<string>).detail === id && latest.current();
    window.addEventListener(EXECUTE_EVENT, onExecute);
    return () => {
      window.removeEventListener(EXECUTE_EVENT, onExecute);
      v.destroy();
    };
  }, []);

  useEffect(() => {
    if (active) view.current?.focus();
  }, [active]);

  const drag = (e: PointerEvent) => {
    if (!e.buttons) return;
    const el = box.current!;
    setHeight(Math.max(60, Math.min(el.clientHeight - 100, e.clientY - el.getBoundingClientRect().top)));
  };

  return (
    <div class="sql-tab" ref={box}>
      <div class="editor" ref={host} style={{ height }} />
      <div
        class="splitter"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
        onPointerMove={drag}
      />
      <ResultPane
        result={result}
        idle={kind === 'mongo' ? 'Type a JSON command and press Ctrl+Enter.' : 'Type a statement and press Ctrl+Enter.'}
      />
    </div>
  );
}

export function TableTab({ target, session }: { target: Target; session?: Session }) {
  const hasProps = !!session?.columns;
  const [sub, setSub] = useState<'props' | 'data'>(hasProps ? 'props' : 'data');
  const [props, loadProps] = useQuery();
  const [data, loadData] = useQuery();
  const [page, setPage] = useState(0);

  const load = (p: number) => {
    setPage(p);
    return loadData(() => (session ? session.rows(target, p * PAGE_SIZE, PAGE_SIZE) : Promise.reject(notConnected())));
  };
  useEffect(() => {
    load(0);
    const columns = session?.columns;
    if (columns) loadProps(() => columns(target));
  }, [session]);

  // ponytail: no total count (a full count is expensive), so Next is enabled until a short page comes back.
  const busy = data.state === 'busy';
  const n = data.state === 'ok' ? data.grid.rows.length : 0;
  const first = page * PAGE_SIZE;

  return (
    <div class="table-tab">
      <div class="subtabs" role="tablist">
        {hasProps && (
          <button class={`subtab${sub === 'props' ? ' active' : ''}`} role="tab" aria-selected={sub === 'props'} onClick={() => setSub('props')}>
            Properties
          </button>
        )}
        <button class={`subtab${sub === 'data' ? ' active' : ''}`} role="tab" aria-selected={sub === 'data'} onClick={() => setSub('data')}>
          Data
        </button>
        {sub === 'data' && (
          <button class="icon-btn" title="Refresh" aria-label="Refresh" onClick={() => load(page)}>
            <Icon n="refresh" />
          </button>
        )}
      </div>
      <div class="results-body">
        <GridPane result={sub === 'props' ? props : data} name={sub === 'props' ? 'properties' : 'data'} />
      </div>
      <div class={`footer${sub === 'data' ? ' has-pager' : ''}`}>
        <span role="status">{sub === 'data' ? footer(data) : ''}</span>
        {sub === 'data' && (
          <span class="pager">
            <button class="btn btn-text" disabled={busy || page === 0} onClick={() => load(0)}>
              First
            </button>
            <button class="btn btn-text" disabled={busy || page === 0} onClick={() => load(page - 1)}>
              Prev
            </button>
            <span class="pager-range">{n ? `rows ${first + 1}–${first + n}` : busy ? '' : 'no rows'}</span>
            <button class="btn btn-text" disabled={busy || n < PAGE_SIZE} onClick={() => load(page + 1)}>
              Next
            </button>
          </span>
        )}
      </div>
    </div>
  );
}
