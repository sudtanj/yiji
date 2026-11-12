import { useEffect, useRef, useState } from 'preact/hooks';
import { clearSettings } from './backends';
import { AboutDialog, ConnDialog, MessageDialog } from './dialogs';
import { type ConnConfig, type Session, type Target, connect } from './db';
import { EXECUTE_EVENT, SqlTab, TableTab } from './editor';
import { Icon } from './icons';
import { Navigator } from './navigator';
import type { Vault } from './store';
import { errMsg } from './util';

interface Tab {
  id: string;
  connId: string;
  title: string;
  target?: Target;
}

type Dialog =
  | null
  | { type: 'conn'; initial?: ConnConfig }
  | { type: 'about' }
  | { type: 'message'; title: string; text: string };

interface MenuItem {
  label: string;
  hint?: string;
  run: () => void;
  disabled?: boolean;
  /** Draws a divider above this item. */
  sep?: boolean;
}

let tabSeq = 0;

function Menu({ items, onDone, pos }: { items: MenuItem[]; onDone: () => void; pos?: { x: number; y: number } }) {
  const box = useRef<HTMLDivElement>(null);
  const enabled = () => [...box.current!.querySelectorAll<HTMLElement>('button:not(:disabled)')];
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => {
    enabled()[0]?.focus();
    // Only restore focus if nothing else took it (e.g. a dialog opened by the chosen item).
    return () => {
      const a = document.activeElement;
      if (!a || a === document.body) opener?.focus?.();
    };
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const btns = enabled();
    const next = btns.indexOf(document.activeElement as HTMLElement) + (e.key === 'ArrowDown' ? 1 : -1);
    btns[(next + btns.length) % btns.length]?.focus();
  };
  return (
    <div
      ref={box}
      class={`popup${pos ? ' ctx' : ''}`}
      role="menu"
      style={pos ? { left: pos.x, top: pos.y } : undefined}
      onKeyDown={onKeyDown}
      onClick={(e) => e.stopPropagation()}
    >
      {items.map((i) => (
        <>
          {i.sep && <div class="menu-sep" role="separator" />}
          <button
            class="menu-item"
            role="menuitem"
            disabled={i.disabled}
            onClick={() => {
              onDone();
              i.run();
            }}
          >
            <span>{i.label}</span>
            <span class="hint">{i.hint}</span>
          </button>
        </>
      ))}
    </div>
  );
}

export function App({ vault }: { vault: Vault<ConnConfig> | null }) {
  const [conns, setConns] = useState<ConnConfig[]>([]);
  const [sessions, setSessions] = useState<Record<string, Session>>({});
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState('');
  const [selId, setSelId] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [menu, setMenu] = useState('');
  const [ctx, setCtx] = useState<{ x: number; y: number; id: string } | null>(null);
  const [status, setStatus] = useState('Ready');
  const scripts = useRef<Record<string, number>>({});
  const pending = useRef(new Set<string>());
  const deleted = useRef(new Set<string>());
  const leaving = useRef(false);

  const message = (title: string, text: string) => setDialog({ type: 'message', title, text });

  useEffect(() => {
    if (!vault) return;
    vault
      .list()
      .then(({ items, failed }) => {
        setConns(items);
        if (failed) {
          message(
            'Some connections are hidden',
            `${failed} saved connection(s) could not be decrypted or failed their integrity check.`,
          );
        }
      })
      .catch((e) => message('Cannot load connections', errMsg(e)));
  }, [vault]);

  // ponytail: the beforeunload prompt is the only guard against closing the tab with unsaved SQLite edits.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (!leaving.current && Object.values(sessions).some((s) => s.dirty?.())) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [sessions]);

  const active = tabs.find((t) => t.id === activeId) ?? tabs[tabs.length - 1];
  const cur = conns.find((c) => c.id === selId) ?? conns.find((c) => c.id === active?.connId);
  const live = cur && sessions[cur.id];
  const runnable = !!active && !active.target;

  const connectTo = async (id: string) => {
    const cfg = conns.find((c) => c.id === id);
    if (!cfg || sessions[id] || pending.current.has(id)) return;
    pending.current.add(id);
    setStatus(`Connecting to ${cfg.name}...`);
    try {
      const s = await connect(cfg);
      if (deleted.current.has(id)) {
        setStatus('Ready');
        return s.close();
      }
      setSessions((p) => ({ ...p, [id]: s }));
      setStatus(`Connected to ${cfg.name}`);
    } catch (e) {
      setStatus(`Connection to ${cfg.name} failed`);
      // A background connect must not replace a dialog the user is working in.
      setDialog((d) => d ?? { type: 'message', title: 'Connection failed', text: errMsg(e) });
    } finally {
      pending.current.delete(id);
    }
  };

  const disconnect = (id: string) => {
    sessions[id]?.close();
    setSessions(({ [id]: _, ...rest }) => rest);
    setStatus('Disconnected');
  };

  // True when the user chose to keep a local SQLite database that has unsaved changes.
  const keepChanges = (id: string) =>
    !!sessions[id]?.dirty?.() &&
    !confirm('This SQLite database has unsaved changes (connection menu > Save SQLite file). Discard them?');

  const askDisconnect = (id: string) => {
    if (!keepChanges(id)) disconnect(id);
  };

  const newScript = (connId = cur?.id) => {
    const cfg = conns.find((c) => c.id === connId);
    if (!cfg) return setDialog({ type: 'conn' });
    connectTo(cfg.id);
    const n = (scripts.current[cfg.id] = (scripts.current[cfg.id] ?? 0) + 1);
    const tab = { id: `t${++tabSeq}`, connId: cfg.id, title: `${cfg.name} Script-${n}` };
    setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
    setDrawer(false);
  };

  const openTable = (connId: string, target: Target) => {
    const key = JSON.stringify(target);
    const found = tabs.find((t) => t.connId === connId && JSON.stringify(t.target) === key);
    const tab = found ?? { id: `t${++tabSeq}`, connId, title: target.name, target };
    if (!found) setTabs((t) => [...t, tab]);
    setActiveId(tab.id);
    setDrawer(false);
  };

  const closeTab = (id: string) => setTabs((t) => t.filter((x) => x.id !== id));

  const execute = () => {
    if (active && runnable) window.dispatchEvent(new CustomEvent(EXECUTE_EVENT, { detail: active.id }));
  };

  const saveConn = async (cfg: ConnConfig) => {
    // Renaming alone keeps the session; any other change needs a fresh connection.
    const old = conns.find((c) => c.id === cfg.id);
    const reconnect = !!old && !!sessions[cfg.id] && JSON.stringify({ ...old, name: '' }) !== JSON.stringify({ ...cfg, name: '' });
    if (reconnect && keepChanges(cfg.id)) return;
    if (!vault) throw new Error('Not logged in.');
    await vault.save(cfg);
    if (reconnect) disconnect(cfg.id);
    setConns((c) => (c.some((x) => x.id === cfg.id) ? c.map((x) => (x.id === cfg.id ? cfg : x)) : [...c, cfg]));
    setSelId(cfg.id);
    setDialog(null);
  };

  const removeConn = async (id: string) => {
    const cfg = conns.find((c) => c.id === id);
    if (!cfg || !confirm(`Delete connection "${cfg.name}"?`) || keepChanges(id)) return;
    try {
      if (!vault) throw new Error('Not logged in.');
      await vault.remove(id);
    } catch (e) {
      return message('Cannot delete connection', errMsg(e));
    }
    deleted.current.add(id);
    disconnect(id);
    setTabs((t) => t.filter((x) => x.connId !== id));
    setConns((c) => c.filter((x) => x.id !== id));
  };

  const keys = useRef({ execute, newScript, modal: false });
  keys.current = { execute, newScript, modal: dialog !== null };
  useEffect(() => {
    // Capture phase so these win over CodeMirror's own Mod-Enter and Mod-] bindings.
    const onKey = (e: KeyboardEvent) => {
      if (keys.current.modal || !(e.ctrlKey || e.metaKey) || (e.key !== 'Enter' && e.key !== ']')) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') keys.current.execute();
      else keys.current.newScript();
    };
    const close = () => {
      setMenu('');
      setCtx(null);
    };
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      close();
      setDrawer(false);
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keydown', onEsc);
    window.addEventListener('click', close);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keydown', onEsc);
      window.removeEventListener('click', close);
    };
  }, []);

  const connItems = (id: string): MenuItem[] => {
    const on = !!sessions[id];
    return [
      { label: 'Connect', run: () => connectTo(id), disabled: on },
      { label: 'Disconnect', run: () => askDisconnect(id), disabled: !on },
      { label: 'Edit connection...', run: () => setDialog({ type: 'conn', initial: conns.find((c) => c.id === id) }) },
      { label: 'Save SQLite file', run: () => sessions[id]?.save?.(), disabled: !sessions[id]?.save },
      { label: 'New SQL script', hint: 'Ctrl+]', run: () => newScript(id) },
      { label: 'Delete', run: () => removeConn(id), sep: true },
    ];
  };

  const newConn = () => setDialog({ type: 'conn' });
  const moreItems: MenuItem[] = [
    { label: 'About Yiji', run: () => setDialog({ type: 'about' }) },
    {
      label: 'Log out',
      sep: true,
      run: () => {
        if (Object.keys(sessions).some(keepChanges)) return;
        if (!confirm('Log out? This forgets the relay URL and password on this device.')) return;
        clearSettings();
        leaving.current = true;
        location.reload();
      },
    },
  ];

  return (
    <div class="app">
      <header class="appbar" onClick={(e) => e.stopPropagation()}>
        <button class="icon-btn only-phone" aria-label="Connections" aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>
          <Icon n="menu" />
        </button>
        <h1 class="app-title">Yiji</h1>
        <span class="grow" />
        <div class="menu-wrap">
          <button
            class="chip"
            aria-haspopup="menu"
            aria-expanded={menu === 'conn'}
            disabled={!cur}
            onClick={() => (setCtx(null), setMenu(menu === 'conn' ? '' : 'conn'))}
          >
            <span class={`dot${live ? ' on' : ''}`} aria-hidden="true" />
            <span class="label">{cur ? `${cur.name} · ${live ? 'connected' : 'disconnected'}` : 'No connection selected'}</span>
          </button>
          {menu === 'conn' && cur && <Menu items={connItems(cur.id)} onDone={() => setMenu('')} />}
        </div>
        <button class="btn btn-tonal" aria-label="New script" title="New SQL script (Ctrl+])" onClick={() => newScript()}>
          <Icon n="sql" />
          <span class="lbl">New script</span>
        </button>
        <button class="btn btn-filled" aria-label="Run" title="Run (Ctrl+Enter)" disabled={!runnable} onClick={execute}>
          <Icon n="play" />
          <span class="lbl">Run</span>
        </button>
        <div class="menu-wrap">
          <button
            class="icon-btn"
            aria-label="More"
            aria-haspopup="menu"
            aria-expanded={menu === 'more'}
            onClick={() => (setCtx(null), setMenu(menu === 'more' ? '' : 'more'))}
          >
            <Icon n="more" />
          </button>
          {menu === 'more' && <Menu items={moreItems} onDone={() => setMenu('')} />}
        </div>
      </header>
      <div class="main">
        <aside class={`navigator${drawer ? ' open' : ''}`} aria-label="Connections">
          <h2 class="nav-title">Connections</h2>
          <button class="fab" onClick={newConn}>
            <Icon n="add" />
            New connection
          </button>
          <Navigator
            conns={conns}
            sessions={sessions}
            onPick={setSelId}
            onOpen={openTable}
            onConnect={connectTo}
            onContext={(x, y, id) => setCtx({ x, y, id })}
          />
        </aside>
        {drawer && <div class="scrim" onClick={() => setDrawer(false)} />}
        <section class="editors">
          {active ? (
            <>
              <div class="tabstrip" role="tablist">
                {tabs.map((t) => (
                  <div
                    class={`tab${t.id === active.id ? ' active' : ''}`}
                    role="tab"
                    aria-selected={t.id === active.id}
                    tabIndex={0}
                    onClick={() => setActiveId(t.id)}
                    onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setActiveId(t.id)}
                  >
                    <Icon n={t.target ? 'table' : 'sql'} />
                    <span class="label">{t.title}</span>
                    <button
                      class="x"
                      aria-label={`Close ${t.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(t.id);
                      }}
                    >
                      <Icon n="close" />
                    </button>
                  </div>
                ))}
              </div>
              <div class="panels">
                {tabs.map((t) => (
                  <div class="panel" role="tabpanel" hidden={t.id !== active.id}>
                    {t.target ? (
                      <TableTab target={t.target} session={sessions[t.connId]} />
                    ) : (
                      <SqlTab
                        id={t.id}
                        kind={conns.find((c) => c.id === t.connId)!.kind}
                        session={sessions[t.connId]}
                        active={t.id === active.id}
                      />
                    )}
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div class="empty-state">
              <h2>Nothing open</h2>
              <p>Start a SQL script, or open a table from a connection. Ctrl+] creates a script from anywhere.</p>
              <div class="empty-actions">
                <button class="btn btn-filled" onClick={() => newScript()}>
                  <Icon n="sql" />
                  New script
                </button>
                <button class="btn btn-text" onClick={newConn}>
                  New connection
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
      <div class="statusbar" role="status">
        {status}
      </div>
      {ctx && (
        <Menu items={connItems(ctx.id)} onDone={() => setCtx(null)} pos={ctx} />
      )}
      {dialog?.type === 'conn' && <ConnDialog initial={dialog.initial} onSave={saveConn} onClose={() => setDialog(null)} />}
      {dialog?.type === 'about' && <AboutDialog onClose={() => setDialog(null)} />}
      {dialog?.type === 'message' && <MessageDialog title={dialog.title} text={dialog.text} onClose={() => setDialog(null)} />}
    </div>
  );
}
