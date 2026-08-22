'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  STALE_HEARTBEAT_MS,
  classifyDaemonState,
  runDaemonHealthCheck,
  listDaemonStateDirs,
  DAEMON_PID_FILE,
} = require('../electron/local-runtime/daemonHealth.cjs');

test('classifyDaemonState: hung when alive and heartbeat stale', () => {
  const now = 1_000_000;
  const killFn = () => {};
  const result = classifyDaemonState({
    heartbeat: { ts: now - STALE_HEARTBEAT_MS - 1, status: 'busy', pid: 9 },
    pidFromFile: 9,
    now,
    killFn,
  });
  assert.equal(result.verdict, 'hung');
  assert.equal(result.action, 'kill');
});

test('classifyDaemonState: healthy when fresh', () => {
  const now = 1_000_000;
  const result = classifyDaemonState({
    heartbeat: { ts: now - 1_000, status: 'online', pid: 9 },
    pidFromFile: 9,
    now,
    killFn: () => {},
  });
  assert.equal(result.verdict, 'healthy');
});

test('classifyDaemonState: stale_dead when pid is gone', () => {
  const now = 1_000_000;
  const result = classifyDaemonState({
    heartbeat: { ts: now, status: 'online', pid: 9 },
    pidFromFile: 9,
    now,
    killFn: () => {
      const err = new Error('gone');
      err.code = 'ESRCH';
      throw err;
    },
  });
  assert.equal(result.verdict, 'stale_dead');
  assert.equal(result.action, 'clean');
});

test('runDaemonHealthCheck fixes hung and stale-dead under a temp homedir', () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-health-'));
  const hungDir = path.join(homedir, '.agensis', 'ws1', 'ag-hung');
  const deadDir = path.join(homedir, '.agensis', 'ws1', 'ag-dead');
  fs.mkdirSync(hungDir, { recursive: true });
  fs.mkdirSync(deadDir, { recursive: true });

  fs.writeFileSync(path.join(hungDir, DAEMON_PID_FILE), '4242\n');
  fs.writeFileSync(
    path.join(hungDir, 'heartbeat.json'),
    JSON.stringify({
      ts: Date.now() - STALE_HEARTBEAT_MS - 10_000,
      status: 'busy',
      busy: true,
      pid: 4242,
      handle: 'codex',
    }),
  );

  fs.writeFileSync(path.join(deadDir, DAEMON_PID_FILE), '9999\n');
  fs.writeFileSync(
    path.join(deadDir, 'heartbeat.json'),
    JSON.stringify({ ts: Date.now(), status: 'online', pid: 9999, handle: 'claude' }),
  );

  let hungAlive = true;
  const report = runDaemonHealthCheck({
    fix: true,
    homedir,
    log: () => {},
    killFn: (pid, signal) => {
      if (pid === 4242) {
        if (signal === 0) {
          if (!hungAlive) {
            const err = new Error('gone');
            err.code = 'ESRCH';
            throw err;
          }
          return;
        }
        if (signal === 'SIGTERM' || signal === 'SIGKILL') hungAlive = false;
        return;
      }
      if (pid === 9999 && signal === 0) {
        const err = new Error('gone');
        err.code = 'ESRCH';
        throw err;
      }
    },
  });

  assert.equal(report.hung, 1);
  assert.equal(report.staleDead, 1);
  assert.equal(report.actions.length, 2);
  assert.equal(fs.existsSync(path.join(hungDir, DAEMON_PID_FILE)), false);
  assert.equal(fs.existsSync(path.join(deadDir, DAEMON_PID_FILE)), false);
  const beat = JSON.parse(fs.readFileSync(path.join(hungDir, 'heartbeat.json'), 'utf8'));
  assert.equal(beat.status, 'stopped');

  fs.rmSync(homedir, { recursive: true, force: true });
});

test('listDaemonStateDirs skips reserved roots', () => {
  const homedir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-health-'));
  fs.mkdirSync(path.join(homedir, '.agensis', 'daemon-profiles'), { recursive: true });
  const dir = path.join(homedir, '.agensis', 'ws', 'ag');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'heartbeat.json'), '{}');
  const listed = listDaemonStateDirs({ homedir });
  assert.deepEqual(listed, [{ dir, workspace: 'ws', agent: 'ag' }]);
  fs.rmSync(homedir, { recursive: true, force: true });
});

test('desktop restore path runs health before autostart', () => {
  const main = fs.readFileSync(path.join(__dirname, '../electron/main.cjs'), 'utf8');
  assert.match(main, /sweepDaemonHealthOnStartup/);
  assert.match(main, /health \(\$\{reason\}\)/);
});
