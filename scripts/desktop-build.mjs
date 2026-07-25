/**
 * Builds the Native SDK desktop app as a THIN SHELL over the hosted backend.
 *
 * Same contract as the old electron-build: VITE_BACKEND_BASE_URL is baked into
 * the Vite bundle ONLY for this desktop build. The web build (`npm run build`,
 * what Netlify runs) never sees it.
 *
 * Usage:
 *   node scripts/desktop-build.mjs              → package for current OS
 *   node scripts/desktop-build.mjs --target macos
 * Override backend: VITE_BACKEND_BASE_URL=... node scripts/desktop-build.mjs
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveZigGlobalCacheDir } from './desktop-build-env.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(root, 'desktop');
const BACKEND_URL = process.env.VITE_BACKEND_BASE_URL || 'https://agensis-backend.fly.dev';
const ZIG_GLOBAL_CACHE_DIR = resolveZigGlobalCacheDir(desktopDir);

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

function packageTarget() {
  const flag = process.argv.find(arg => arg.startsWith('--target='));
  if (flag) return flag.slice('--target='.length);
  const idx = process.argv.indexOf('--target');
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function run(cmd, args, { cwd = root, env = {} } = {}) {
  const label = `${cmd} ${args.join(' ')}`;
  console.log(`\n[desktop:build] ${label}`);
  const result = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: false,
  });
  if (result.status !== 0) {
    console.error(`[desktop:build] step failed: ${label}`);
    process.exit(result.status ?? 1);
  }
}

const target = packageTarget();
console.log(`[desktop:build] baking VITE_BACKEND_BASE_URL=${BACKEND_URL}`);
console.log(`[desktop:build] package target=${target}`);

// 1. app icon  2. web bundle with hosted backend URL  3. native package
run(npmCmd, ['run', 'icon']);
// AGENSIS_DESKTOP_BUILD is what switches Vite to relative asset URLs (`base:
// './'`) for the file:// shell. It is deliberately separate from
// VITE_BACKEND_BASE_URL: a WEB deploy may legitimately bake a backend URL, and
// relative asset URLs break the /app sub-path there (they resolve under /app/
// and come back as the SPA shell instead of JS).
run(npmCmd, ['run', 'build'], { env: { VITE_BACKEND_BASE_URL: BACKEND_URL, AGENSIS_DESKTOP_BUILD: '1' } });
run('zig', ['build', 'package', `-Dpackage-target=${target}`, '-Doptimize=ReleaseFast'], {
  cwd: desktopDir,
  env: { ZIG_GLOBAL_CACHE_DIR },
});

console.log('\n[desktop:build] done — output in desktop/zig-out/package/');
