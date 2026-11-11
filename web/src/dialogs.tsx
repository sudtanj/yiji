import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { checkRelayUrl, loadSettings, openVault, saveSettings } from './backends';
import { type ConnConfig, type Kind, connect } from './db';
import { Icon } from './icons';
import type { Vault } from './store';
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
  // Read during the first render, before an autoFocus input in the dialog takes focus.
  const [opener] = useState(() => document.activeElement as HTMLElement | null);
  useEffect(() => () => opener?.focus?.(), [opener]);
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

export function Login(props: { initialUrl: string; initialError: string; onUnlock: (v: Vault<ConnConfig>) => void }) {
  const [url, setUrl] = useState(props.initialUrl);
  const [pw, setPw] = useState('');
  const [error, setError] = useState(props.initialError);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const u = url.trim();
    const bad = checkRelayUrl(u) ?? (pw ? null : 'Enter the relay password.');
    if (bad) return setError(bad);
    setBusy(true);
    setError('');
    try {
      const settings = { url: u, password: pw };
      const vault = await openVault(settings);
      saveSettings(settings);
      props.onUnlock(vault);
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title="Connect to relay"
      onSubmit={submit}
      buttons={
        <button type="submit" class="primary" disabled={busy}>
          {busy ? 'Connecting...' : 'Connect'}
        </button>
      }
    >
      <p class="msg">
        Your saved connections are stored through the relay, encrypted with this password. The same password is the
        relay token. The URL and password stay on this device until you log out.
      </p>
      <label class="field">
        <span>Relay URL</span>
        <input
          autoFocus={!url}
          value={url}
          placeholder="wss://relay.example/"
          onInput={(e) => setUrl(e.currentTarget.value)}
          autocomplete="url"
        />
      </label>
      <label class="field">
        <span>Password</span>
        <input
          type="password"
          autoFocus={!!url}
          value={pw}
          onInput={(e) => setPw(e.currentTarget.value)}
          autocomplete="current-password"
        />
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

const blank = (kind: Kind, saved = loadSettings()): ConnConfig => ({
  id: crypto.randomUUID(),
  name: '',
  kind,
  host: 'localhost',
  port: kind === 'mongo' ? 27017 : 5432,
  database: '',
  mongoDb: '',
  user: '',
  password: '',
  relayUrl: saved?.url ?? '',
  relayToken: saved?.password ?? '',
  sqliteMode: 'file',
  url: '',
  authToken: '',
});

type TextKey = 'name' | 'host' | 'database' | 'mongoDb' | 'user' | 'password' | 'relayUrl' | 'relayToken' | 'url' | 'authToken';

function invalid(c: ConnConfig): string | null {
  if (c.kind === 'sqlite') return c.sqliteMode === 'remote' && !c.url.trim() ? 'URL is required.' : null;
  if (!c.host.trim()) return 'Host is required.';
  if (!(c.port >= 1 && c.port <= 65535)) return 'Port must be between 1 and 65535.';
  const relayUrl = c.relayUrl.trim();
  if (!relayUrl) return 'Relay URL is required.';
  const badUrl = checkRelayUrl(relayUrl);
  if (badUrl) return badUrl;
  const saved = loadSettings();
  if (saved && c.relayToken === saved.password && relayUrl !== saved.url) {
    return 'This token is your login password. Send it only to your own relay, or enter that relay’s token.';
  }
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
