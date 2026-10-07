/**
 * Dev loop for the desktop shell (Zig + native_sdk).
 *
 * Two targets (API + WebSocket + ACP registration):
 *
 *   local  (default)  — http://127.0.0.1:<APP_PORT|3142>
 *     Starts local backend if needed. Live web (agensis.io) will NOT see ACP
 *     agents as online.
 *
 *   prod   (--prod / --live)
 *     Points Vite at the hosted Fly backend. No local backend. ACP processes
 *     still run on this Mac; bridges register where live web looks.
 *
 * Override either mode with VITE_BACKEND_BASE_URL=…
 *
 * Port handling:
 *   - Vite dev server picks the first free port starting at 5173 (or
 *     AGENSIS_VITE_PORT). The launcher reads Vite's actual port from stdout
 *     and threads it into the desktop shell via AGENSIS_DEV_ORIGINS so the
 *     origin allowlist matches whatever Vite bound to.
 *   - Backend defaults to 3142 but honors APP_PORT (already supported by
 *     docker-compose.yml). Override at runtime with APP_PORT=<free>.
 *
 * Usage:
 *   node scripts/desktop-dev.mjs                 # local
 *   node scripts/desktop-dev.mjs --local        # local (explicit)
 *   node scripts/desktop-dev.mjs --prod         # hosted
 *   node scripts/desktop-dev.mjs --live         # alias of --prod
 */
import { spawn } from 'node:child_process';
import net from 'node:net';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';

const HOSTED_BACKEND = 'https://agensis-backend.fly.dev';
const DEFAULT_LOCAL_BACKEND_PORT = 3142;
const DEFAULT_VITE_PORT = 5173;

const argv = process.argv.slice(2);
const flagLocal = argv.includes('--local');
const flagProd = argv.includes('--prod') || argv.includes('--live')
  || process.env.AGENSIS_DESKTOP_LIVE === '1'
  || process.env.AGENSIS_DESKTOP_LIVE === 'true';

if (flagLocal && flagProd) {
  console.error('[desktop:dev] Use only one of --local or --prod');
  process.exit(1);
}

function resolveLocalBackendBase() {
  const envPort = Number.parseInt(process.env.APP_PORT, 10);
  const port = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_LOCAL_BACKEND_PORT;
  return `http://127.0.0.1:${port}`;
}

/**
 * Resolve which HTTP origin the renderer + ACP mint/bridge should use.
 * Explicit VITE_BACKEND_BASE_URL always wins.
 */
function resolveBackendBase() {
  const explicit = String(process.env.VITE_BACKEND_BASE_URL || '').trim().replace(/\/+$/, '');
  if (explicit) return explicit;
  if (flagProd) return HOSTED_BACKEND;
  return resolveLocalBackendBase();
}

const backendBase = resolveBackendBase();
const backendPort = Number.parseInt(new URL(backendBase).port, 10)
  || (new URL(backendBase).hostname === '127.0.0.1' ? DEFAULT_LOCAL_BACKEND_PORT : 0);
const mode = isLoopbackBackend(backendBase) ? 'local' : 'prod';

function isLoopbackBackend(base) {
  try {
    const host = new URL(base).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '::1';
  } catch {
    return false;
  }
}

/**
 * Find a free TCP port starting at `preferred`. Returns the port number or
 * throws if none could be bound in the search window.
 */
async function findFreePort(preferred, searchWindow = 50) {
  for (let p = preferred; p < preferred + searchWindow; p++) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await canBind(p);
    if (ok) return p;
  }
  throw new Error(`No free port found in [${preferred}, ${preferred + searchWindow})`);
}

function canBind(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(false));
    tester.once('listening', () => tester.close(() => resolve(true)));
    tester.listen(port, '127.0.0.1');
  });
}

let shuttingDown = false;
let electronProcess;
let backendProcess;
let viteProcess;

async function isBackendRunning(url) {
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

/**
 * Spawn Vite without --strictPort and parse the actual listening port from
 * its stdout. Resolves once a port has been discovered.
 */
function spawnViteAndDiscoverPort(viteArgs, viteEnv) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const child = spawn(npmCmd, ['run', 'dev', '--', ...viteArgs], {
      env: viteEnv,
    });
    viteProcess = child;

    // Vite prints: "  ➜  Local:   http://localhost:5173/"
    const portRe = /Local:\s+https?:\/\/[^/]+:(\d+)/;

    const onChunk = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(text);
      if (resolved) return;
      const match = text.match(portRe);
      if (match) {
        resolved = true;
        resolve({ child, port: Number.parseInt(match[1], 10) });
      }
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', (c) => process.stderr.write(c));
    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        reject(new Error(`Vite exited before printing a port (code=${code})`));
      }
    });

    // Safety timeout: if Vite hasn't printed a port within 25s, give up.
    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        reject(new Error('Timed out waiting for Vite to print its listening port'));
      }
    }, 25_000);
  });
}

function shutdown() {
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
    console.log('[desktop:dev] Skipping local backend.');
    try {
      await waitForServer(`${backendBase}/backend/health`, 15_000);
      console.log('[desktop:dev] Hosted backend reachable.');
    } catch {
      console.warn(`[desktop:dev] Warning: could not reach ${backendBase}/backend/health — continuing anyway.`);
    }
  } else {
    console.log('[desktop:dev] Local stack. Live web will not show these agents as online.');
    console.log('[desktop:dev] For live web pairing use: npm run desktop:dev:prod');
    const healthcheck = `${backendBase}/backend/health`;
    const backendAlreadyRunning = await isBackendRunning(healthcheck);
    if (!backendAlreadyRunning) {
      console.log(`[desktop:dev] No backend on ${backendBase}; spawning one (APP_PORT=${backendPort}).`);
      backendProcess = spawn(npmCmd, ['run', 'backend'], {
        stdio: 'inherit',
        env: { ...process.env, ...(backendPort ? { APP_PORT: String(backendPort) } : {}) },
      });
      await waitForServer(healthcheck);
    } else {
      console.log(`[desktop:dev] Backend already up on ${backendBase}; reusing.`);
    }
  }

  const preferredVitePort = Number.parseInt(process.env.AGENSIS_VITE_PORT, 10) || DEFAULT_VITE_PORT;
  const vitePort = await findFreePort(preferredVitePort);
  console.log(`[desktop:dev] Vite will listen on 127.0.0.1:${vitePort}`);

  const viteEnv = {
    ...process.env,
    BROWSER: 'none',
    VITE_BACKEND_BASE_URL: backendBase,
  };

  // No --strictPort: Vite picks the first free port and we read it from stdout.
  const viteArgs = ['--host', '127.0.0.1', '--port', String(vitePort), '--strictPort=false'];
  const { port: actualVitePort } = await spawnViteAndDiscoverPort(viteArgs, viteEnv);
  const devUrl = `http://127.0.0.1:${actualVitePort}`;
  console.log(`[desktop:dev] Vite ready at ${devUrl}`);

  // The desktop shell reads AGENSIS_DEV_ORIGINS (pipe-separated) and adds it
  // to its origin allowlist on top of the always-on zero:// schemes.
  const devOrigins = `http://127.0.0.1:${actualVitePort}`;

  const cleanup = shutdown;
  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  process.on('exit', cleanup);

  if (backendProcess) {
    backendProcess.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`Backend server exited early with code ${code ?? 'unknown'}`);
        shutdown();
        process.exit(code ?? 1);
      }
    });
  }

  viteProcess.on('exit', (code) => {
    if (!shuttingDown) {
      console.error(`Vite exited early with code ${code ?? 'unknown'}`);
      shutdown();
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
      AGENSIS_DEV_ORIGINS: devOrigins,
      VITE_BACKEND_BASE_URL: backendBase,
    },
  });

  electronProcess.on('exit', (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[desktop:dev] Failed to start desktop dev mode');
  console.error(error);
  process.exit(1);
});
