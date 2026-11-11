import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;
const live = process.env.SMOKE_URL;

export default defineConfig({
  testDir: 'e2e',
  retries: live ? 3 : 0,
  use: { ...devices['Desktop Chrome'], baseURL: live ?? `http://127.0.0.1:${PORT}/` },
  projects: [{ name: 'chromium' }],
  webServer: live
    ? undefined
    : { command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`, url: `http://127.0.0.1:${PORT}/` },
});
