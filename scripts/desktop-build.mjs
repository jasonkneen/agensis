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
//   node scripts/desktop-build.mjs                 → prod backend (default, ship)
//   node scripts/desktop-build.mjs --prod          → hosted Fly (explicit)
//   node scripts/desktop-build.mjs --local         → http://127.0.0.1:3142 (dev package)
//   node scripts/desktop-build.mjs --publish never → build, don't publish
// Override: VITE_BACKEND_BASE_URL=… node scripts/desktop-build.mjs
//
// Arch (mac): package.json targets arm64 ONLY — never x64/Rosetta by default.
//   Host arch is also forced on the CLI so a stale dual-arch config cannot
//   sneak x64 back in. Opt into Intel only with an explicit --x64 (discouraged).
//
// macOS signing (Developer ID):
//   Local: package.json mac.identity + keychain cert
//     "Developer ID Application: Jason Kneen (SW75ZJJ5R6)"
//   CI: set CSC_LINK (base64 .p12) + CSC_KEY_PASSWORD
//   Notarize (optional, recommended for Gatekeeper): set one of
//     APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER
//     APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID (SW75ZJJ5R6)
//   Skip sign only when explicitly forced: CSC_IDENTITY_AUTO_DISCOVERY=false
//     (release workflow must NOT set that once certs are configured).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOSTED_BACKEND = 'https://agensis-backend.fly.dev';
const LOCAL_BACKEND = 'http://127.0.0.1:3142';

const MODE_FLAGS = new Set(['--local', '--prod', '--live']);
const ARCH_FLAGS = new Set(['--arm64', '--x64', '--universal', '--ia32']);

const rawArgs = process.argv.slice(2);
const flagLocal = rawArgs.includes('--local');
const flagProd = rawArgs.includes('--prod') || rawArgs.includes('--live');
if (flagLocal && flagProd) {
  console.error('[desktop:build] Use only one of --local or --prod');
  process.exit(1);
}

// electron-builder passthrough; strip our mode flags only.
const passthrough = rawArgs.filter((a) => !MODE_FLAGS.has(a));

const explicit = String(process.env.VITE_BACKEND_BASE_URL || '').trim().replace(/\/+$/, '');
const BACKEND_URL = explicit
  || (flagLocal ? LOCAL_BACKEND : HOSTED_BACKEND);
const mode = flagLocal || BACKEND_URL.includes('127.0.0.1') || BACKEND_URL.includes('localhost')
  ? 'local'
  : 'prod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const isMac = process.platform === 'darwin';
const hostArch = process.arch; // arm64 on Apple Silicon, x64 on Intel

/**
 * Never default to building both x64+arm64 on Mac — that downloads x64 Electron
 * and rebuilds native modules under Rosetta. package.json is arm64-only; we also
 * pass an explicit --arm64/--x64 matching the host unless the caller already
 * named an arch flag.
 *
 * Mac-only: package.json's win target is x64-only (no win-arm64 build config),
 * so matching host arch on Windows would pass --arm64 to electron-builder on an
 * ARM64 dev machine and fail — there's no win-arm64 target to build. Let
 * electron-builder fall back to its own default (the configured win/linux
 * targets) on non-Mac hosts.
 */
function resolveBuilderArchArgs() {
  if (passthrough.some((a) => ARCH_FLAGS.has(a))) {
    return []; // caller owns arch selection
  }
  if (isMac && (hostArch === 'arm64' || hostArch === 'x64')) {
    return [`--${hostArch}`];
  }
  return [];
}

const archArgs = resolveBuilderArchArgs();

// Call node entrypoints directly. `npm.cmd` / `npx.cmd` with shell:false fails
// on Windows GitHub runners (ENOENT / empty status) before any script runs.
function run(args, extraEnv = {}) {
  const label = `node ${args.join(' ')}`;
  console.log(`\n[desktop:build] ${label}`);
  const result = spawnSync(node, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extraEnv },
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`[desktop:build] step failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

console.log(`[desktop:build] mode=${mode}  hostArch=${hostArch}  baking VITE_BACKEND_BASE_URL=${BACKEND_URL}`);
if (archArgs.length) {
  console.log(`[desktop:build] arch=${archArgs.join(' ')} (native only — no Rosetta / no dual-arch)`);
}
if (mode === 'local') {
  console.log('[desktop:build] Local package: needs a running backend on :3142. Live web will not see local agents.');
} else {
  console.log('[desktop:build] Prod package: API/ACP → hosted backend (same as live web).');
}
if (isMac) {
  const auto = process.env.CSC_IDENTITY_AUTO_DISCOVERY;
  console.log(`[desktop:build] mac signing: identity from package.json / keychain; CSC_IDENTITY_AUTO_DISCOVERY=${auto ?? '(default true)'}`);
  if (auto === 'false' && !process.env.CSC_LINK) {
    console.warn('[desktop:build] WARNING: signing auto-discovery is off and CSC_LINK is unset — mac build will be UNSIGNED');
  }
  if (hostArch === 'arm64' && passthrough.includes('--x64')) {
    console.warn('[desktop:build] WARNING: --x64 on Apple Silicon builds Intel Electron (Rosetta). Prefer arm64.');
  }
}

// 1. app icon  2. web bundle w/ backend URL baked in  3. package with electron-builder
run([path.join(root, 'scripts', 'generate-icon.cjs')]);
run(
  [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'],
  { VITE_BACKEND_BASE_URL: BACKEND_URL, AGENSIS_DESKTOP_BUILD: '1' },
);
// Prefer signing on macOS unless the caller explicitly disables discovery.
const builderEnv = {};
if (isMac && process.env.CSC_IDENTITY_AUTO_DISCOVERY === undefined && !process.env.CSC_LINK) {
  builderEnv.CSC_IDENTITY_AUTO_DISCOVERY = 'true';
}
run(
  [path.join(root, 'node_modules', 'electron-builder', 'cli.js'), ...archArgs, ...passthrough],
  builderEnv,
);

if (isMac && process.env.SKIP_DESKTOP_SIGN_VERIFY !== '1') {
  run([path.join(root, 'scripts', 'desktop-verify-sign.mjs')]);
}

console.log('\n[desktop:build] done — output in release/');
