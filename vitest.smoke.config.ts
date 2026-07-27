import { defineConfig } from 'vitest/config';

// The pre-push visual smoke gate (`npm run smoke`).
//
// A SEPARATE runner from `npm run test:unit` on purpose. The unit suite proves
// pieces are individually correct; this one mounts whole surfaces and asserts
// they are not showing an empty state over real data — the one thing a green
// typecheck/lint/vitest/node/build run structurally cannot tell you, and the
// gap that let a workspace of 8 agents render "you haven't created any agents
// yet" (2026-07-27). Keeping the configs apart means neither suite's baseline
// count moves when the other grows, and the gate can be run on its own before
// a deploy without paying for 1735 unit tests.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['tests/smoke/**/*.smoke.ts'],
    setupFiles: ['tests/smoke/setup.ts'],
    globals: false,
    // One surface at a time. These mount React trees into a shared jsdom
    // document; parallel files would race on it for no speed win at this size.
    fileParallelism: false,
    // A surface that has not painted in 10s is wedged, and a gate that hangs
    // gets skipped. Fail instead.
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
    },
  },
});
