import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { App } from './app';
import { loadSettings, makeBackend } from './backends';
import type { ConnConfig } from './db';
import { Unlock } from './dialogs';
import type { Vault } from './store';
import './styles.css';

function Root() {
  const [vault, setVault] = useState<Vault<ConnConfig> | null>(null);
  const backend = useMemo(() => makeBackend(loadSettings()), []);
  return vault ? <App vault={vault} /> : <Unlock backend={backend} onUnlock={setVault} />;
}

render(<Root />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
