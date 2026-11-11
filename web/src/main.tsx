import { render } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { App } from './app';
import { loadSettings, openVault } from './backends';
import type { ConnConfig } from './db';
import { Login } from './dialogs';
import type { Vault } from './store';
import { errMsg } from './util';
import './styles.css';

function Root() {
  const [saved] = useState(loadSettings);
  const [vault, setVault] = useState<Vault<ConnConfig> | null>(null);
  const [connecting, setConnecting] = useState(saved !== null);
  const [error, setError] = useState('');

  // A failed silent login keeps the saved settings: the relay may just be down.
  useEffect(() => {
    if (!saved) return;
    openVault(saved)
      .then(setVault)
      .catch((e) => {
        setError(errMsg(e));
        setConnecting(false);
      });
  }, []);

  if (vault) return <App vault={vault} />;
  if (connecting) return <p class="msg" role="status">Connecting to relay...</p>;
  return <Login initialUrl={saved?.url ?? ''} initialError={error} onUnlock={setVault} />;
}

render(<Root />, document.getElementById('app')!);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker not registered', e));
}
