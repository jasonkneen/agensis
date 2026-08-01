/**
 * Dev loop for the Electron desktop shell.
 *
 * Two targets (API + WebSocket + ACP registration):
 *
 *   local  (default)  — http://127.0.0.1:3142
 *     Starts local backend if needed. Live web (agensis.io) will NOT see ACP
 *     agents as online.
 *
 *   prod   (--prod / --live)
 *     Points Vite at the hosted Fly backend. No local backend. ACP processes
 *     still run on this Mac; bridges register where live web looks.
 *
 * Override either mode with VITE_BACKEND_BASE_URL=…
 *
 * AGENSIS_BACKEND_EXTERNAL=1 tells electron/main.cjs not to start an in-process
 * backend.
 *
 * Usage:
 *   node scripts/desktop-dev.mjs           # local
 *   node scripts/desktop-dev.mjs --local   # local (explicit)
 *   node scripts/desktop-dev.mjs --prod    # hosted
 *   node scripts/desktop-dev.mjs --live    # alias of --prod
 */
import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';
const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';

const HOSTED_BACKEND = 'https://agensis-backend.fly.dev';
const LOCAL_BACKEND = 'http://127.0.0.1:3142';

const argv = process.argv.slice(2);
const flagLocal = argv.includes('--local');
const flagProd = argv.includes('--prod') || argv.includes('--live')
  || process.env.AGENSIS_DESKTOP_LIVE === '1'
  || process.env.AGENSIS_DESKTOP_LIVE === 'true';

if (flagLocal && flagProd) {
  console.error('[desktop:dev] Use only one of --local or --prod');
  process.exit(1);
}

/**
 * Resolve which HTTP origin the renderer + ACP mint/bridge should use.
 * Explicit VITE_BACKEND_BASE_URL always wins.
 */
function resolveBackendBase() {
  const explicit = String(process.env.VITE_BACKEND_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (flagProd) return HOSTED_BACKEND;
  // default + --local: empty → same-origin / vite proxy → local backend
  // We still force LOCAL_BACKEND into the env for ACP mint clarity when --local.
  if (flagLocal) return LOCAL_BACKEND;
  return LOCAL_BACKEND;
}

const backendBase = resolveBackendBase();
const mode = isLoopbackBackend(backendBase) ? 'local' : 'prod';

function isLoopbackBackend(base) {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
  } catch {
    return false;
  }
}

let shuttingDown = false;
let electronProcess;
let backendProcess;

async function isBackendRunning(url = `${LOCAL_BACKEND}/backend/health`) {
  try {
    const response = await fetch(url, { method: 'GET' });
    return response.ok;
  } catch {
    return false;
  }
}

function killProcess(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {
    // ignore
  }
}

async function waitForServer(url, timeoutMs = 30_000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(url, { method: 'GET' });
      if (response.ok) return;
    } catch {
      // keep polling
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for server at ${url}`);
}

function shutdown(viteProcess) {
  if (shuttingDown) return;
  shuttingDown = true;
  killProcess(electronProcess);
  killProcess(backendProcess);
  killProcess(viteProcess);
}

async function main() {
  console.log(`[desktop:dev] mode=${mode}  backend=${backendBase}`);

  if (mode === 'prod') {
    console.log('[desktop:dev] ACP processes run on this Mac; bridges register on hosted backend (live web can see them).');
    console.log('[desktop:dev] Skipping local :3142.');
    try {
      await waitForServer(`${backendBase}/backend/health`, 15_000);
      console.log('[desktop:dev] Hosted backend reachable.');
    } catch {
      console.warn(`[desktop:dev] Warning: could not reach ${backendBase}/backend/health — continuing anyway.`);
    }
  } else {
    console.log('[desktop:dev] Local stack. Live web will not show these agents as online.');
    console.log('[desktop:dev] For live web pairing use: npm run desktop:dev:prod');
    const backendAlreadyRunning = await isBackendRunning();
    if (!backendAlreadyRunning) {
      backendProcess = spawn(npmCmd, ['run', 'backend'], {
        stdio: 'inherit',
        env: { ...process.env },
      });
      await waitForServer(`${LOCAL_BACKEND}/backend/health`);
    }
  }

  const viteEnv = {
    ...process.env,
    BROWSER: 'none',
    VITE_BACKEND_BASE_URL: backendBase,
  };

  const viteProcess = spawn(
    npmCmd,
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    {
      stdio: 'inherit',
      env: viteEnv,
    },
  );

  const cleanup = () => shutdown(viteProcess);
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  if (backendProcess) {
    backendProcess.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`Backend server exited early with code ${code ?? 'unknown'}`);
        shutdown(viteProcess);
        process.exit(code ?? 1);
      }
    });
  }

  viteProcess.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`Vite exited early with code ${code ?? 'unknown'}`);
      shutdown(viteProcess);
      process.exit(code ?? 1);
    }
  });

  await waitForServer(devUrl);

  electronProcess = spawn(npxCmd, ['electron', '.'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_DEV_SERVER_URL: devUrl,
      AGENSIS_BACKEND_EXTERNAL: '1',
      VITE_BACKEND_BASE_URL: backendBase,
    },
  });

  electronProcess.on('exit', (code) => {
    shutdown(viteProcess);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[desktop:dev] Failed to start Electron dev mode');
  console.error(error);
  process.exit(1);
});
