import { defineConfig } from 'vitest/config';
import { defaultServerConditions } from 'vite';

// Minimal unit-test harness. Scoped to tests/unit/** ONLY so it never picks up
// the node:test cjs backend suite under tests/*.test.cjs (run via `npm test`).
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/unit/**/*.test.ts'],
    globals: false,
    // Same preload the node:test runner gets via `--require`: a test process
    // sees a known environment, never the machine's `.env`. See the header of
    // tests/helpers/test-env.cjs.
    setupFiles: ['./tests/helpers/test-env.cjs'],
  },
  resolve: {
    // Match vite.config.ts: resolve @agensis/ui to its TS source, not a dist
    // build that does not exist during development.
    conditions: ['source', ...defaultServerConditions],
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
  ssr: {
    resolve: { conditions: ['source', ...defaultServerConditions] },
  },
});
