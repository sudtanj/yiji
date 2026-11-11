import preact from '@preact/preset-vite';
import { defineConfig } from 'vitest/config';

// Relative base so the same build runs at / and under /yiji/ on GitHub Pages.
export default defineConfig({
  base: './',
  plugins: [preact()],
  build: { target: 'esnext' },
  optimizeDeps: { exclude: ['@sqlite.org/sqlite-wasm', 'yiji-wasm'] },
  test: { include: ['src/**/*.test.ts'] },
});
