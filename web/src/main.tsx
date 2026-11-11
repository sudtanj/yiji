import { render } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { App } from './app';
import { loadSettings, makeBackend } from './backends';
import type { ConnConfig } from './db';
import { Unlock } from './dialogs';
import type { Vault } from './store';
import { errMsg } from './util';
import './styles.css';

function Root() {
  const [vault, setVault] = useState<Vault<ConnConfig> | null>(null);
  const store = useMemo(() => {
    try {
      return { backend: makeBackend(loadSettings()), error: '' };
    } catch (e) {
      return { backend: undefined, error: `The connection store settings are invalid. ${errMsg(e)}` };
    }
  }, []);
  return vault ? <App vault={vault} /> : <Unlock backend={store.backend} initialError={store.error} onUnlock={setVault} />;
}

render(<Root />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
