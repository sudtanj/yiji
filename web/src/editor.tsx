import { json } from '@codemirror/lang-json';
import { PostgreSQL, SQLite, sql } from '@codemirror/lang-sql';
import { EditorState } from '@codemirror/state';
import { EditorView, placeholder } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef, useState } from 'preact/hooks';
import { type Kind, type Session, type Target, notConnected } from './db';
import { GridPane, ResultPane, footer, useQuery } from './grid';
import { Icon } from './icons';

export const EXECUTE_EVENT = 'yiji:execute';

const theme = EditorView.theme({
  '&': { height: '100%', fontSize: '13px' },
  '.cm-scroller': { fontFamily: 'Consolas, "DejaVu Sans Mono", monospace' },
  '.cm-gutters': { background: '#f0f0f0', color: '#666', borderRight: '1px solid #d0d0d0' },
});

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
  const view = useRef<EditorView>();
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

  const refresh = () => loadData(() => (session ? session.rows(target) : Promise.reject(notConnected())));
  useEffect(() => {
    refresh();
    const columns = session?.columns;
    if (columns) loadProps(() => columns(target));
  }, [session]);

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
          <button class="tb" title="Refresh" aria-label="Refresh" onClick={refresh}>
            <Icon n="refresh" />
          </button>
        )}
      </div>
      <div class="results-body">
        <GridPane result={sub === 'props' ? props : data} name={sub === 'props' ? 'properties' : 'data'} />
      </div>
      <div class="footer" role="status">
        {sub === 'data' ? footer(data) : ''}
      </div>
    </div>
  );
}
