import { expect, test } from '@playwright/test';

// Not covered: logging in and the app shell. That needs a relay with a Turso database behind it.
test('loads, asks for the relay, rejects an insecure URL and registers the service worker', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('./');
  // The app renders (inert) behind the popup, so scope lookups to the dialog.
  const login = page.getByRole('dialog', { name: 'Connect to relay' });
  await expect(login).toBeVisible();
  await login.getByLabel('Relay URL').fill('http://relay.example/');
  await login.getByLabel('Password', { exact: true }).fill('smoke-test-password');
  await login.getByRole('button', { name: 'Connect' }).click();
  await expect(login.getByRole('alert')).toContainText('must start with wss://');
  expect(await page.evaluate(() => localStorage.getItem('yiji.relay'))).toBeNull();

  const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  expect(scope).toBe(new URL('./', page.url()).href);

  expect(problems).toEqual([]);
});
