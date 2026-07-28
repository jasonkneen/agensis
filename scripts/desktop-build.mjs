// Builds the Electron desktop app as a THIN SHELL over the hosted backend.
//
// The one thing that makes the desktop app point at the real service instead of
// a (nonexistent) local backend is VITE_BACKEND_BASE_URL, baked into the bundle
// here. It is set ONLY for this desktop build — the web build (`npm run build`,
// what Netlify runs) never sees it, so the web bundle stays byte-for-byte the
// same-origin build it has always been. That's the "do NOT compromise web"
// guarantee: web safety is structural, not a promise.
//
// AGENSIS_DESKTOP_BUILD=1 is deliberately separate from VITE_BACKEND_BASE_URL:
// it switches Vite to relative asset URLs (`base: './'`) so `dist/index.html`
// loads under file:// inside the Electron window — absolute `/assets/*` URLs
// would 404 there. A WEB deploy may legitimately bake a backend URL, and
// relative asset URLs would break the /app sub-path there (they resolve under
// /app/ and come back as the SPA shell instead of JS).
//
// Cross-platform (no `cross-env` dependency, works on the Windows target too):
// we set process.env and spawn each step directly.
//
// Usage:
//   node scripts/desktop-build.mjs                   → dmg/zip/nsis (default)
//   node scripts/desktop-build.mjs --publish never   → build, don't publish
// Override the backend for staging: VITE_BACKEND_BASE_URL=... node scripts/desktop-build.mjs
import { spawnSync } from 'node:child_process';

const BACKEND_URL = process.env.VITE_BACKEND_BASE_URL || 'https://agensis-backend.fly.dev';
const passthrough = process.argv.slice(2); // e.g. --publish never

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

function run(cmd, args, extraEnv = {}) {
  const label = `${cmd} ${args.join(' ')}`;
  console.log(`\n[desktop:build] ${label}`);
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`[desktop:build] step failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`[desktop:build] baking VITE_BACKEND_BASE_URL=${BACKEND_URL} into the desktop bundle`);

// 1. app icon  2. web bundle w/ backend URL baked in  3. package with electron-builder
run(npmCmd, ['run', 'icon']);
run(npxCmd, ['vite', 'build'], { VITE_BACKEND_BASE_URL: BACKEND_URL, AGENSIS_DESKTOP_BUILD: '1' });
run(npxCmd, ['electron-builder', ...passthrough]);

console.log('\n[desktop:build] done — output in release/');
