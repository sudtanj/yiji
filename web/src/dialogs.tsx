import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { checkSettings, clearSettings, hasStoredSettings, loadSettings, saveSettings } from './backends';
import { type ConnConfig, type Kind, connect } from './db';
import { Icon } from './icons';
import { type Backend, Vault, hasVault } from './store';
import { errMsg } from './util';

export function Modal(props: {
  title: string;
  children: ComponentChildren;
  buttons: ComponentChildren;
  onSubmit?: () => void;
  onClose?: () => void;
}) {
  const { onClose } = props;
  useEffect(() => {
    if (!onClose) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    return () => opener?.focus?.();
  }, []);
  return (
    <div class="overlay" role="dialog" aria-modal="true" aria-label={props.title}>
      <form
        class="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit?.();
        }}
      >
        <div class="dlg-title">{props.title}</div>
        <div class="dlg-body">{props.children}</div>
        <div class="dlg-buttons">{props.buttons}</div>
      </form>
    </div>
  );
}

export function MessageDialog({ title, text, onClose }: { title: string; text: string; onClose: () => void }) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      onSubmit={onClose}
      buttons={
        <button type="submit" class="primary" autoFocus>
          OK
        </button>
      }
    >
      <p class="msg">{text}</p>
    </Modal>
  );
}

export function AboutDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      title="About Yiji"
      onClose={onClose}
      onSubmit={onClose}
      buttons={
        <button type="submit" class="primary" autoFocus>
          OK
        </button>
      }
    >
      <p class="msg">
        Yiji, a database client for PostgreSQL, MongoDB and SQLite that runs in the browser. MIT licence. Not affiliated
        with DBeaver.
      </p>
    </Modal>
  );
}

export function Unlock(props: {
  backend?: Backend;
  initialError?: string;
  onUnlock: (v: Vault<ConnConfig>) => void;
}) {
  const { backend } = props;
  const [first, setFirst] = useState<boolean>();
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [error, setError] = useState(props.initialError ?? '');
  const [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    if (!backend) return;
    hasVault(backend)
      .then((has) => setFirst(!has))
      .catch((e) => setError(`Cannot reach the connection store. ${errMsg(e)}`));
  }, []);

  const submit = async () => {
    if (!backend) return;
    if (first && pw.length < 10) return setError('Use at least 10 characters.');
    if (first && pw !== pw2) return setError('The two passwords do not match.');
    setBusy(true);
    setError('');
    try {
      props.onUnlock(await Vault.unlock<ConnConfig>(backend, pw));
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        title={first ? 'Set master password' : 'Unlock Yiji'}
        onSubmit={submit}
        buttons={
          <>
            <button type="button" class="left" onClick={() => setSettings(true)}>
              Connection store...
            </button>
            {error && hasStoredSettings() && (
              <button
                type="button"
                onClick={() => {
                  clearSettings();
                  location.reload();
                }}
              >
                Use browser storage
              </button>
            )}
            <button type="submit" class="primary" disabled={busy || first === undefined}>
              {busy ? 'Working...' : first ? 'Create' : 'Unlock'}
            </button>
          </>
        }
      >
        {first && (
          <p class="msg">
            This password encrypts your saved connections. It is never stored or sent anywhere, and it cannot be
            recovered.
          </p>
        )}
        <label class="field">
          <span>Master password</span>
          <input type="password" autoFocus value={pw} onInput={(e) => setPw(e.currentTarget.value)} autocomplete="current-password" />
        </label>
        {first && (
          <label class="field">
            <span>Repeat password</span>
            <input type="password" value={pw2} onInput={(e) => setPw2(e.currentTarget.value)} autocomplete="new-password" />
          </label>
        )}
        {error && (
          <p class="msg error" role="alert">
            {error}
          </p>
        )}
      </Modal>
      {settings && <SettingsDialog onClose={() => setSettings(false)} />}
    </>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const current = loadSettings();
  const [url, setUrl] = useState(current?.url ?? '');
  const [token, setToken] = useState(current?.token ?? '');
  const [error, setError] = useState('');

  const save = () => {
    const u = url.trim();
    if (u) {
      const bad = checkSettings(u);
      if (bad) return setError(bad);
      saveSettings({ url: u, token: token.trim() });
    } else {
      clearSettings();
    }
    location.reload();
  };

  return (
    <Modal
      title="Connection store"
      onClose={onClose}
      onSubmit={save}
      buttons={
        <>
          <button type="submit" class="primary">
            Save and restart
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <p class="msg">
        With a Turso (libSQL) URL, saved connections go to your Turso database, encrypted with your master password.
        Leave the URL empty to use this browser. The token may be empty for a server without auth. The URL and token
        are kept in this browser in plain text. Saving restarts Yiji and asks for the master password of the new
        store; connections are not copied between stores.
      </p>
      <label class="field">
        <span>Turso URL</span>
        <input value={url} placeholder="libsql://name-org.turso.io" onInput={(e) => setUrl(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span>Auth token</span>
        <input type="password" value={token} onInput={(e) => setToken(e.currentTarget.value)} autocomplete="off" />
      </label>
      {error && (
        <p class="msg error" role="alert">
          {error}
        </p>
      )}
    </Modal>
  );
}

const TYPES: { kind: Kind; label: string }[] = [
  { kind: 'postgres', label: 'PostgreSQL' },
  { kind: 'mongo', label: 'MongoDB' },
  { kind: 'sqlite', label: 'SQLite' },
];
const ICON = { postgres: 'pg', mongo: 'mongo', sqlite: 'sqlite' } as const;

const blank = (kind: Kind): ConnConfig => ({
  id: crypto.randomUUID(),
  name: '',
  kind,
  host: 'localhost',
  port: kind === 'mongo' ? 27017 : 5432,
  database: '',
  mongoDb: '',
  user: '',
  password: '',
  relayUrl: '',
  relayToken: '',
  sqliteMode: 'file',
  url: '',
  authToken: '',
});

type TextKey = 'name' | 'host' | 'database' | 'mongoDb' | 'user' | 'password' | 'relayUrl' | 'relayToken' | 'url' | 'authToken';

function invalid(c: ConnConfig): string | null {
  if (c.kind === 'sqlite') return c.sqliteMode === 'remote' && !c.url.trim() ? 'URL is required.' : null;
  if (!c.host.trim()) return 'Host is required.';
  if (!(c.port >= 1 && c.port <= 65535)) return 'Port must be between 1 and 65535.';
  if (!c.relayUrl.trim()) return 'Relay URL is required.';
  return null;
}

export function ConnDialog(props: {
  initial?: ConnConfig;
  onSave: (c: ConnConfig) => Promise<void>;
  onClose: () => void;
}) {
  const [step, setStep] = useState(props.initial ? 2 : 1);
  const [cfg, setCfg] = useState<ConnConfig>(props.initial ?? blank('postgres'));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const text = (k: TextKey) => ({
    value: cfg[k],
    onInput: (e: Event) => setCfg((c) => ({ ...c, [k]: (e.currentTarget as HTMLInputElement).value })),
  });
  const pickKind = (kind: Kind) => setCfg(() => blank(kind));

  const test = async () => {
    const bad = invalid(cfg);
    if (bad) return setMsg({ ok: false, text: bad });
    setBusy(true);
    setMsg(null);
    try {
      (await connect(cfg)).close();
      setMsg({ ok: true, text: 'Connected' });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    const bad = invalid(cfg);
    if (bad) return setMsg({ ok: false, text: bad });
    setBusy(true);
    try {
      const fallback = cfg.kind === 'sqlite' ? 'SQLite' : `${cfg.database || 'db'} @ ${cfg.host}`;
      await props.onSave({ ...cfg, name: cfg.name.trim() || fallback });
    } catch (e) {
      setMsg({ ok: false, text: errMsg(e) });
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Connect to a database"
      onClose={props.onClose}
      onSubmit={step === 1 ? () => setStep(2) : finish}
      buttons={
        <>
          {step === 2 && (
            <button type="button" class="left" onClick={test} disabled={busy}>
              Test Connection...
            </button>
          )}
          <button type="button" onClick={() => setStep(1)} disabled={step === 1 || !!props.initial}>
            &lt; Back
          </button>
          <button type="submit" class="primary" disabled={busy}>
            {step === 1 ? 'Next >' : 'Finish'}
          </button>
          <button type="button" onClick={props.onClose}>
            Cancel
          </button>
        </>
      }
    >
      {step === 1 ? (
        <>
          <p class="msg">Select your database</p>
          <div class="tiles" role="radiogroup" aria-label="Database type">
            {TYPES.map((t) => (
              <button
                type="button"
                class="tile"
                role="radio"
                aria-checked={cfg.kind === t.kind}
                onClick={() => pickKind(t.kind)}
                onDblClick={() => {
                  pickKind(t.kind);
                  setStep(2);
                }}
              >
                <Icon n={ICON[t.kind]} />
                {t.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div class="section">Main</div>
          {cfg.kind === 'sqlite' ? (
            <>
              <div class="field">
                <span>Type</span>
                <div class="radios" role="radiogroup" aria-label="SQLite source">
                  {(['file', 'remote'] as const).map((m) => (
                    <label>
                      <input
                        type="radio"
                        name="mode"
                        checked={cfg.sqliteMode === m}
                        onChange={() => setCfg((c) => ({ ...c, sqliteMode: m }))}
                      />
                      {m === 'file' ? 'Local file' : 'Remote (libSQL/Turso)'}
                    </label>
                  ))}
                </div>
              </div>
              {cfg.sqliteMode === 'file' ? (
                <p class="msg">The file is chosen when you connect. It is opened in memory; use File &gt; Save to download changes.</p>
              ) : (
                <>
                  <label class="field">
                    <span>URL</span>
                    <input {...text('url')} placeholder="libsql://name-org.turso.io" />
                  </label>
                  <label class="field">
                    <span>Auth token</span>
                    <input {...text('authToken')} type="password" autocomplete="off" />
                  </label>
                </>
              )}
            </>
          ) : (
            <>
              <label class="field">
                <span>Host</span>
                <input {...text('host')} />
              </label>
              <label class="field">
                <span>Port</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={cfg.port}
                  onInput={(e) => setCfg((c) => ({ ...c, port: e.currentTarget.valueAsNumber }))}
                />
              </label>
              <label class="field">
                <span>{cfg.kind === 'mongo' ? 'Auth database' : 'Database'}</span>
                <input {...text('database')} />
              </label>
              {cfg.kind === 'mongo' && (
                <label class="field">
                  <span>Database</span>
                  <input {...text('mongoDb')} placeholder="Default: auth database" />
                </label>
              )}
              <label class="field">
                <span>Username</span>
                <input {...text('user')} autocomplete="off" />
              </label>
              <label class="field">
                <span>Password</span>
                <input {...text('password')} type="password" autocomplete="off" />
              </label>
              <label class="field">
                <span>Relay URL</span>
                <input {...text('relayUrl')} placeholder="wss://relay.example/" />
              </label>
              <label class="field">
                <span>Relay token</span>
                <input {...text('relayToken')} type="password" autocomplete="off" />
              </label>
            </>
          )}
          <label class="field">
            <span>Connection name</span>
            <input {...text('name')} placeholder="Optional" />
          </label>
          {busy && !msg && <p class="msg">Working...</p>}
        </>
      )}
      {msg && (
        <p class={`msg${msg.ok ? '' : ' error'}`} role={msg.ok ? 'status' : 'alert'}>
          {msg.text}
        </p>
      )}
    </Modal>
  );
}
