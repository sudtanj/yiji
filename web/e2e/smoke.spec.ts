import { expect, test } from '@playwright/test';

// Not covered: running `select 1`. A local SQLite connection opens a native file picker and a
// remote one needs a libSQL server; the remote path is covered by src/turso.integration.test.ts.
test('loads, creates a local vault, renders the shell and registers the service worker', async ({ page }) => {
  const problems: string[] = [];
  page.on('console', (m) => m.type() === 'error' && problems.push(m.text()));
  page.on('pageerror', (e) => problems.push(e.message));

  await page.goto('./');
  await expect(page.getByRole('dialog', { name: 'Set master password' })).toBeVisible();
  await page.getByLabel('Master password', { exact: true }).fill('smoke-test-password');
  await page.getByLabel('Repeat password', { exact: true }).fill('smoke-test-password');
  await page.getByRole('button', { name: 'Create' }).click();

  await expect(page.getByRole('menubar')).toBeVisible();
  for (const name of ['File', 'Database', 'SQL Editor', 'Help']) {
    await expect(page.getByRole('menubar').getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('toolbar', { name: 'Main toolbar' })).toBeVisible();
  await expect(page.getByRole('tree', { name: 'Database Navigator' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('Ready');

  const rows = await page.evaluate(() => JSON.parse(localStorage.getItem('yiji.connections') ?? '[]'));
  expect(rows.map((r: { id: string }) => r.id)).toEqual(['_vault']);

  const scope = await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope));
  expect(scope).toBe(new URL('./', page.url()).href);

  expect(problems).toEqual([]);
});
