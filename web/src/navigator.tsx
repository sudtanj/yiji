import { useEffect, useState } from 'preact/hooks';
import type { ConnConfig, Item, Session, Target } from './db';
import { Icon, type IconId } from './icons';
import { errMsg } from './util';

interface Kids {
  open: boolean;
  items?: Item[];
  err?: string;
  busy?: boolean;
}

interface Shared {
  picked: string;
  pick: (path: string, connId: string) => void;
  onOpen: (connId: string, t: Target) => void;
  onContext: (x: number, y: number, connId: string) => void;
}

interface NodeProps extends Shared {
  path: string;
  depth: number;
  connId: string;
  label: string;
  icon: IconId;
  load?: () => Promise<Item[]>;
  target?: Target;
  /** Connection rows only: reload when the session changes, and connect on activate. */
  conn?: { session?: Session; connect: () => void };
}

function Node(p: NodeProps) {
  const [st, setSt] = useState<Kids>({ open: false });

  const expand = async () => {
    setSt({ open: true, busy: true });
    try {
      setSt({ open: true, items: await p.load!() });
    } catch (e) {
      setSt({ open: true, err: errMsg(e) });
    }
  };
  const toggle = () => {
    if (!p.load) return;
    if (st.open) setSt({ ...st, open: false });
    else if (st.items) setSt({ ...st, open: true });
    else expand();
  };
  const activate = () => {
    if (p.target) p.onOpen(p.connId, p.target);
    else if (p.conn && !p.conn.session) p.conn.connect();
    else toggle();
  };

  useEffect(() => {
    if (!p.conn) return;
    setSt({ open: false });
    if (p.conn.session) expand();
  }, [p.conn?.session]);

  const select = () => p.pick(p.path, p.connId);
  return (
    <div role="none">
      <div
        class={`row${p.picked === p.path ? ' picked' : ''}`}
        role="treeitem"
        aria-level={p.depth + 1}
        aria-expanded={p.load ? st.open : undefined}
        aria-selected={p.picked === p.path}
        tabIndex={0}
        style={{ paddingLeft: 4 + p.depth * 16 }}
        onClick={() => {
          select();
          // On phones a single tap opens a table; there is no practical double-tap.
          if (p.target && matchMedia('(max-width: 720px)').matches) activate();
        }}
        onDblClick={activate}
        onKeyDown={(e) => e.key === 'Enter' && activate()}
        onContextMenu={(e) => {
          e.preventDefault();
          select();
          p.onContext(e.clientX, e.clientY, p.connId);
        }}
      >
        <span
          class={`twisty${p.load && (!p.conn || p.conn.session) ? '' : ' none'}${st.open ? ' open' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            toggle();
          }}
        >
          <Icon n="chevron" />
        </span>
        <Icon n={p.icon} />
        <span class="label">{p.label}</span>
      </div>
      {st.open && (
        <div role="group">
          {st.busy && <div class="row note" style={{ paddingLeft: 24 + (p.depth + 1) * 16 }}>Loading...</div>}
          {st.err && (
            <div class="row note error" role="alert" style={{ paddingLeft: 24 + (p.depth + 1) * 16 }}>
              {st.err}
            </div>
          )}
          {st.items?.length === 0 && (
            <div class="row note" style={{ paddingLeft: 24 + (p.depth + 1) * 16 }}>(empty)</div>
          )}
          {st.items?.map((it) => (
            <Node
              {...p}
              conn={undefined}
              key={it.label}
              path={`${p.path}/${it.label}`}
              depth={p.depth + 1}
              label={it.label}
              icon={it.icon}
              load={it.kids}
              target={it.open}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function Navigator(props: {
  conns: ConnConfig[];
  sessions: Record<string, Session>;
  onPick: (connId: string) => void;
  onOpen: (connId: string, t: Target) => void;
  onConnect: (connId: string) => void;
  onContext: (x: number, y: number, connId: string) => void;
  onNew: () => void;
}) {
  const [picked, setPicked] = useState('');
  const shared: Shared = {
    picked,
    pick: (path, connId) => {
      setPicked(path);
      props.onPick(connId);
    },
    onOpen: props.onOpen,
    onContext: props.onContext,
  };
  return (
    <div class="tree" role="tree" aria-label="Database Navigator">
      {props.conns.length === 0 && (
        <p class="note">
          No connections yet.{' '}
          <button class="link" onClick={props.onNew}>
            New Database Connection...
          </button>
        </p>
      )}
      {props.conns.map((c) => (
        <Node
          {...shared}
          key={c.id}
          path={c.id}
          depth={0}
          connId={c.id}
          label={c.name}
          icon={props.sessions[c.id] ? 'connOn' : 'conn'}
          load={props.sessions[c.id]?.roots}
          conn={{ session: props.sessions[c.id], connect: () => props.onConnect(c.id) }}
        />
      ))}
    </div>
  );
}
