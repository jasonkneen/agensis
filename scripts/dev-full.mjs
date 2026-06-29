#!/usr/bin/env node
// Runs the full daemon-enabled dev stack in one command:
//   - the WebSocket backend (server/index.cjs on :3142) that hosts agent
//     orchestration + the /backend/ws daemon channel, and
//   - vite (the frontend) pointed at that backend via VITE_BACKEND_BASE_URL.
//
// This is the setup required for DAEMON agents (Coder/Q/Mills) to actually
// connect and receive jobs. (`netlify dev` on :8888 is serverless and has no
// WebSocket server, so daemon connections can't be created against it.)
import { spawn } from 'node:child_process';

const BACKEND_URL = 'http://127.0.0.1:3142';

const procs = [];
function run(name, cmd, args, extraEnv = {}) {
  const child = spawn(cmd, args, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnv },
  });
  const tag = `[${name}] `;
  child.stdout.on('data', (d) => process.stdout.write(tag + d.toString().replace(/\n(?!$)/g, '\n' + tag)));
  child.stderr.on('data', (d) => process.stderr.write(tag + d.toString().replace(/\n(?!$)/g, '\n' + tag)));
  child.on('exit', (code) => {
    console.log(`${tag}exited (${code}) — shutting down stack`);
    shutdown();
  });
  procs.push(child);
  return child;
}

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const p of procs) {
    try { p.kill('SIGTERM'); } catch { /* already gone */ }
  }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// --env-file makes the standalone backend pick up DATABASE_URL / ANTHROPIC_API_KEY.
run('backend', process.execPath, ['--env-file=.env', 'server/index.cjs']);
run('vite', 'npx', ['vite'], { VITE_BACKEND_BASE_URL: BACKEND_URL });

console.log(`\nDaemon-enabled dev stack starting:\n  backend  -> ${BACKEND_URL} (WebSocket + agent orchestration)\n  frontend -> vite (uses VITE_BACKEND_BASE_URL=${BACKEND_URL})\nConnect a daemon agent with the command from the AI Agents window.\n`);
