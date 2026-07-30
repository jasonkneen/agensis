'use strict';

// ============================================================================
// tests/graceful-shutdown.test.cjs
// ----------------------------------------------------------------------------
// The backend drains its WebSockets on SIGTERM instead of dying mid-frame.
//
// Fly sends SIGTERM on every deploy, restart and machine move, and Node's
// DEFAULT action for SIGTERM is to exit immediately. No handler existed anywhere
// in this process, so that default is exactly what happened: every browser and
// every daemon socket died as a 1006 — the one close code that carries no reason
// and no intent — and every in-flight agent turn sat as 'running' until the 30s
// reaper failed it. A deploy cost users their work, every time.
//
// Like tests/automations-worker-cadence.test.cjs, the wiring lives at module
// scope inside startBackendServer, which cannot be invoked without binding a
// port and installing real process signal handlers. So the assertions read the
// SOURCE. That is honest for wiring: what is being pinned is which handler is
// installed and what it does, and there is no runtime seam that exposes it
// without the test process signalling ITSELF.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.resolve(__dirname, '../server/index.cjs'), 'utf8');
const flyToml = fs.readFileSync(path.resolve(__dirname, '../fly.toml'), 'utf8');

test('SIGTERM and SIGINT are handled at all', () => {
  // MUTATION: delete either handler -> this fails, and that deploy is back to
  // killing live turns.
  assert.match(source, /process\.on\('SIGTERM', \(\) => shutdown\('SIGTERM'\)\)/);
  assert.match(source, /process\.on\('SIGINT', \(\) => shutdown\('SIGINT'\)\)/);
});

test('the drain closes sockets with 1012, not a code the daemon treats as terminal', () => {
  // THE assertion this file exists for.
  //
  // The daemon stops permanently — no reconnect — on `1008` whose reason matches
  // /agent deactivated|authentication failed/ (see the close handler in
  // agensis-agent packages/agensis-cli/src/agensis.mjs). A deploy must land in
  // its ORDINARY reconnect path instead, so the code has to be one it does not
  // read as terminal. 1012 is "Service Restart" and says precisely that.
  //
  // MUTATION: change this to 1008 -> every daemon in the fleet permanently stops
  // on the next deploy, and this fails.
  assert.match(source, /client\.close\(1012, 'Server restarting'\)/);
  assert.equal(
    /client\.close\(1008/.test(source),
    false,
    'the drain must never use the close code the daemon treats as terminal',
  );
});

test('the drain stops accepting new work before it starts closing sockets', () => {
  // server.close() first, so the load balancer drains us and the 'close' handler
  // clears every interval — nothing new starts while we are shutting down.
  const shutdownBody = source.slice(source.indexOf('const shutdown = (signal) =>'));
  const serverCloseAt = shutdownBody.indexOf('server.close();');
  const clientCloseAt = shutdownBody.indexOf("client.close(1012");
  assert.ok(serverCloseAt > 0, 'the drain must call server.close()');
  assert.ok(clientCloseAt > serverCloseAt, 'server.close() must come before the socket close loop');
});

test('the grace timer is NOT unref\'d', () => {
  // It is the only thing keeping the process alive long enough for those close
  // frames to leave the box. Unref'ing it lets the process exit the instant the
  // last other handle drops — which is the 1006 this whole file exists to stop
  // sending.
  //
  // MUTATION: add `.unref()` to the grace timer -> this fails.
  const shutdownBody = source.slice(
    source.indexOf('const shutdown = (signal) =>'),
    source.indexOf("process.on('SIGTERM'"),
  );
  assert.match(shutdownBody, /setTimeout\(\(\) => \{/, 'the drain arms a grace timer');
  assert.equal(
    /timer\.unref/.test(shutdownBody),
    false,
    "the grace timer must not be unref'd or the drain can be skipped entirely",
  );
});

test('signal handlers are opt-in, so Electron keeps owning its own shutdown', () => {
  // electron/main.cjs calls startBackendServer() in the Electron MAIN process and
  // already shuts the server down through app.on('before-quit'). Installing our
  // handlers there would hijack that: Ctrl-C would exit(0) out of the drain and
  // skip Electron's quit path entirely.
  //
  // MUTATION: default handleSignals to true -> this fails.
  assert.match(source, /function startBackendServer\(port = DEFAULT_PORT, \{ handleSignals = false \} = \{\}\)/);
  assert.match(source, /startBackendServer\(DEFAULT_PORT, \{ handleSignals: true \}\)/);
  const electron = fs.readFileSync(path.resolve(__dirname, '../electron/main.cjs'), 'utf8');
  assert.equal(
    /handleSignals/.test(electron),
    false,
    'the desktop shell must not opt in to process-level signal handling',
  );
});

test('fly.toml allows more time than the drain takes', () => {
  // Fly's default is 5s from SIGTERM to SIGKILL. If kill_timeout is not longer
  // than AGENSIS_SHUTDOWN_GRACE_MS the SIGKILL lands mid-drain and the close
  // frames never leave — the drain would be theatre.
  //
  // MUTATION: drop kill_timeout, or raise the grace past it -> this fails.
  const killTimeout = /kill_timeout\s*=\s*"(\d+)s"/.exec(flyToml);
  assert.ok(killTimeout, 'fly.toml must set kill_timeout');
  const graceDefault = /AGENSIS_SHUTDOWN_GRACE_MS \|\| ([\d_]+)/.exec(source);
  assert.ok(graceDefault, 'the drain must have a default grace window');
  const graceSeconds = Number(graceDefault[1].replace(/_/g, '')) / 1000;
  assert.ok(
    Number(killTimeout[1]) > graceSeconds,
    `kill_timeout (${killTimeout[1]}s) must exceed the drain grace (${graceSeconds}s)`,
  );
});
