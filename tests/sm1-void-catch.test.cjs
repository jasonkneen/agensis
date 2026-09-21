'use strict';

// SM-1 contract test (docs/queue-plumbing-audit-2026-09-21.md):
//
//   "Three sites (agent-connections.cjs:361,367 and realtime.cjs:1100) use
//    bare `void fn()`. A throw inside one of those closes the socket and
//    leaves the agent's queue undrained, with no log line indicating so."
//
// The fix attaches a `.catch((error) => console.error(...))` so a rejection
// in any of these drains surfaces in the logs with the connection id (so
// the operator can correlate with the dropped socket).
//
// We also extend the same pattern to scheduleConnectionJobFailure (the
// grace-window timer at lines 333-336) — it fires 45s after a daemon
// drops and is the SAME surface for the SAME risk.
//
// This file pins the wiring with a contract test on the source — the runtime
// path requires a full app + DB, which is not worth standing up just to
// assert "a `.catch` is attached here".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentConnectionsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'agent-connections.cjs'),
    'utf8',
);
const realtimeSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'realtime.cjs'),
    'utf8',
);
const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'index.cjs'),
    'utf8',
);

function regionFrom(src, startMarker, endMarker) {
 const startIdx = src.indexOf(startMarker);
 assert.ok(startIdx >= 0, `start marker not found: ${startMarker.slice(0, 60)}`);
 const endIdx = src.indexOf(endMarker, startIdx);
 assert.ok(endIdx > startIdx, `end marker not found after ${startIdx}: ${endMarker.slice(0, 60)}`);
 return src.slice(startIdx, endIdx);
}

// (A) eviction branch — fires when a daemon is told to stop (supersede,
// deactivated, runtime_mismatch). Both failConnectionJobs and
// expireConnectionPermissionRequests must have a .catch.
test('SM-1 (A): agent-connections eviction branch logs drain failures', () => {
 const region = regionFrom(
  agentConnectionsSrc,
  "// Told to stop: nothing is coming back",
  '// An unexplained socket loss',
 );
 assert.match(region, /void failConnectionJobs\([^)]*\)\s*\.catch\(\(error\) => console\.error/);
 assert.match(region, /void expireConnectionPermissionRequests\([^)]*\)\s*\.catch\(\(error\) => console\.error/);
});

// (B) grace timer branch — fires 45s after a daemon drops. Same surface,
// same risk, same fix.
test('SM-1 (B): agent-connections grace-timer branch logs drain failures', () => {
 const region = regionFrom(
  agentConnectionsSrc,
  'pendingJobFailures.delete(connectionId);\n   // Bare `void fn()`',
  'timer.unref?.()',
 );
 assert.match(region, /void failConnectionJobs\([^)]*\)\s*\.catch\(\(error\) => console\.error/);
 assert.match(region, /void expireConnectionPermissionRequests\([^)]*\)\s*\.catch\(\(error\) => console\.error/);
});

// (C) realtime close — fires when a websocket closes. markAgentConnectionOffline
// is what fails the agent's queued jobs.
test('SM-1 (C): realtime socket close logs markAgentConnectionOffline failures', () => {
 const region = regionFrom(
  realtimeSrc,
  'voiceRelay.teardown(ws);',
  '// Ping connected sockets',
 );
 assert.match(region, /void markAgentConnectionOffline\(ws\)\s*\.catch\(\(error\) => console\.error/);
});

// (D) startup reconciles — fire-and-forget at boot. A throw here is the
// most silent kind: nobody is watching yet.
test('SM-1 (D): startup reconciles log failures', () => {
 const region = regionFrom(
  indexSrc,
  '[backend] listening on http',
  'void Promise.resolve(app.locals.runtimeSchemaReady)',
 );
 assert.match(region, /void reconcileAgentConnectionsAtStartup\(\)\s*\.catch\(\(error\) => console\.error/);
 assert.match(region, /void reconcileSchedulesAtStartup\(\)\s*\.catch\(\(error\) => console\.error/);
});