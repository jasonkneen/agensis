/**
 * Dev loop for the Native SDK desktop shell.
 *
 * Same shape as the old electron:dev: ensure the local backend is up, then
 * hand off to `zig build dev` in desktop/ which starts Vite (via app.zon)
 * and launches the native WebView shell against it.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const desktopDir = path.join(root, 'desktop');
const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

let shuttingDown = false;
let backendProcess;
let nativeProcess;

async function isBackendRunning(url = 'http://127.0.0.1:3142/backend/health') {
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
  throw new Error(`Timed out waiting for ${url}`);
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  killProcess(nativeProcess);
  killProcess(backendProcess);
}

async function main() {
  const backendAlreadyRunning = await isBackendRunning();

  if (!backendAlreadyRunning) {
    backendProcess = spawn(npmCmd, ['run', 'backend'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env },
    });
    await waitForServer('http://127.0.0.1:3142/backend/health');
  }

  const cleanup = () => shutdown();
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

  // `zig build dev` builds the shell, starts Vite from app.zon, and launches it.
  nativeProcess = spawn('zig', ['build', 'dev'], {
    cwd: desktopDir,
    stdio: 'inherit',
    env: {
      ...process.env,
      BROWSER: 'none',
      AGENSIS_BACKEND_EXTERNAL: '1',
    },
  });

  nativeProcess.on('exit', (code) => {
    shutdown();
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[desktop:dev] Failed to start Native SDK desktop shell');
  console.error(error);
  process.exit(1);
});
