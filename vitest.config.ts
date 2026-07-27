import { defineConfig } from 'vitest/config';

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
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
