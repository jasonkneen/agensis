import { spawn } from 'node:child_process';

const isWindows = process.platform === 'win32';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';
const npxCmd = isWindows ? 'npx.cmd' : 'npx';
const devUrl = process.env.VITE_DEV_SERVER_URL || 'http://127.0.0.1:5173';

let shuttingDown = false;
let electronProcess;
let backendProcess;

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
      // keep polling until Vite is ready
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }

  throw new Error(`Timed out waiting for Vite dev server at ${url}`);
}

function shutdown(viteProcess) {
  if (shuttingDown) return;
  shuttingDown = true;
  killProcess(electronProcess);
  killProcess(backendProcess);
  killProcess(viteProcess);
}

async function main() {
  const backendAlreadyRunning = await isBackendRunning();

  if (!backendAlreadyRunning) {
    backendProcess = spawn(
      npmCmd,
      ['run', 'backend'],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
        },
      },
    );
  }

  if (!backendAlreadyRunning) {
    await waitForServer('http://127.0.0.1:3142/backend/health');
  }

  const viteProcess = spawn(
    npmCmd,
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '5173', '--strictPort'],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        BROWSER: 'none',
      },
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
      HATCH_BACKEND_EXTERNAL: '1',
    },
  });

  electronProcess.on('exit', (code) => {
    shutdown(viteProcess);
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error('[electron:dev] Failed to start Electron dev mode');
  console.error(error);
  process.exit(1);
});
