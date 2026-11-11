import { expect, test } from '@playwright/test';

// Not covered: logging in and the app shell. That needs a relay with a Turso database behind it.
test('loads, asks for the relay, rejects an insecure URL and registers the service worker', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('./');
  await expect(page.getByRole('dialog', { name: 'Connect to relay' })).toBeVisible();
  await page.getByLabel('Relay URL').fill('http://relay.example/');
  await page.getByLabel('Password', { exact: true }).fill('smoke-test-password');
  await page.getByRole('button', { name: 'Connect' }).click();
  await expect(page.getByRole('alert')).toContainText('must start with wss://');
  expect(await page.evaluate(() => localStorage.getItem('yiji.relay'))).toBeNull();

  const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  expect(scope).toBe(new URL('./', page.url()).href);

  expect(problems).toEqual([]);
});
