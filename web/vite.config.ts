import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// sqlite-wasm and yiji-wasm are fetched from 'self' and compiled under 'wasm-unsafe-eval'.
// Applied to production builds only: the dev server needs inline scripts and a ws:// HMR socket.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "connect-src 'self' https: wss:",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

// Relative base so the same build runs at / and under /yiji/ on GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [
    preact(),
    {
      name: 'yiji-csp',
      apply: 'build',
      transformIndexHtml: () => [
        { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
      ],
    },
  ],
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', 'yiji-wasm'] },
  // Vault tests run PBKDF2 at the real minimum iteration count.
  test: { include: ['src/**/*.test.ts'], testTimeout: 60_000 },
});
