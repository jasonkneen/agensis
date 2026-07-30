'use strict';

// A blip must not destroy a turn.
//
// 2026-07-28, live: a Coder turn five minutes deep (worktree created, two edits
// applied, `tsc` running) was killed mid-flight, and the DM job queued behind it
// died in the same sweep. Nothing was wrong with the daemon — it reconnected two
// seconds later and finished the work. Two separate mechanisms threw it away:
//
//   1. The liveness reaper terminated the socket after ONE missed pong inside a
//      15s window. A laptop daemon misses that routinely (Wi-Fi roam, lid nap, an
//      event loop starved by the `claude -p` subprocesses it is supervising).
//   2. 'close' failed every running job on that connection immediately, so there
//      was nothing left to deliver into once the daemon came back.
//
// What must stay true: a DELIBERATE eviction (superseded / deactivated) still
// fails its jobs at once — covered in agent-connection-supersede.test.cjs. This
// file covers the accidental drop, which is the one that must survive.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

// A socket that behaves like ws does for the two things the sweep touches.
function livenessSocket(label) {
  return {
    label,
    readyState: 1,
    isAlive: true,
    missedPongs: 0,
    pings: 0,
    terminated: false,
    ping() { this.pings += 1; },
    terminate() { this.terminated = true; this.readyState = 3; },
    // What the real 'pong' handler does.
    pong() { this.isAlive = true; this.missedPongs = 0; },
  };
}

test('a socket that misses one pong is pinged again, not terminated', () => {
  const ws = livenessSocket('blip');

  // Tick 1: healthy — armed and pinged.
  __test.sweepLiveness([ws]);
  assert.equal(ws.isAlive, false, 'the sweep arms the flag before pinging');
  assert.equal(ws.pings, 1);
  assert.equal(ws.terminated, false);

  // Tick 2: the pong never came. This is the exact point the old code called
  // terminate() and took every in-flight job with it.
  __test.sweepLiveness([ws]);
  assert.equal(ws.terminated, false, 'one missed pong must not kill a working daemon');
  assert.equal(ws.pings, 2, 'it gets another chance to answer');
  assert.equal(ws.missedPongs, 1);
});

test('a socket that misses the tolerance is terminated', () => {
  const ws = livenessSocket('dead');
  for (let i = 0; i < __test.LIVENESS_MAX_MISSED_PONGS + 1; i += 1) __test.sweepLiveness([ws]);
  assert.equal(ws.terminated, true, 'a genuinely dead socket is still reaped');
  assert.equal(ws.missedPongs, __test.LIVENESS_MAX_MISSED_PONGS);
});

test('answering a ping clears the miss counter', () => {
  const ws = livenessSocket('flappy');
  __test.sweepLiveness([ws]);
  __test.sweepLiveness([ws]);
  assert.equal(ws.missedPongs, 1);

  ws.pong();
  assert.equal(ws.missedPongs, 0, 'a late pong forgives the miss');

  // Having answered once, it gets the full budget again rather than dying on the
  // next tick — otherwise a daemon on a flaky link accumulates its way to death.
  __test.sweepLiveness([ws]);
  __test.sweepLiveness([ws]);
  assert.equal(ws.terminated, false);
});

test('the tolerance is more than a single miss', () => {
  assert.ok(
    __test.LIVENESS_MAX_MISSED_PONGS >= 2,
    'one missed pong inside 15s was the whole budget, and it killed live turns',
  );
});

// --- the drop itself: what happens to the turn that was running ---------------

const WORKSPACE = 'ws-1';
const AGENT = 'agent-coder';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

function agentSocket(label) {
  const ws = {
    label,
    readyState: 1,
    isAlive: true,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() { this.readyState = 3; },
  };
  ws.agentAuth = {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    handle: 'coder',
    name: 'Coder',
    agent: { id: AGENT, name: 'Coder', handle: 'coder' },
  };
  return ws;
}

// Fake DB narrow to this file: it records whether the job-failure sweep ran and
// whether the running job was re-homed onto the reconnected connection.
function dropDb({ runningJobs = [] } = {}) {
  const rows = new Map();
  const db = {
    rows,
    jobs: runningJobs,
    failureSweeps: [],
    rehomes: [],
    async unsafe(sql, params = []) {
      const text = norm(sql);

      if (text.startsWith('select id, name, avatar')) {
        return [{
          id: AGENT, name: 'Coder', avatar: 'CO', accent_color: '', description: '',
          soul: '', identity: {}, run_mode: 'daemon', metadata: {}, enabled: true, version: 1,
        }];
      }
      if (text.startsWith('delete from agent_connections where workspace_id')) return [];
      if (text.startsWith('insert into agent_connections')) {
        const [id, workspace_id, agent_id, name, handle, host, cwd, metadata] = params;
        const row = {
          id, workspace_id, agent_id, name, handle, host, cwd,
          status: 'online', metadata, capabilities: {},
          connected_at: new Date().toISOString(),
          last_seen_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        rows.set(id, row);
        return [row];
      }
      if (text.startsWith('update agent_connections set status =')) {
        const row = rows.get(params[0]);
        if (!row) return [];
        row.status = 'offline';
        return [row];
      }
      if (text.startsWith('update agent_jobs set connection_id')) {
        const [connectionId, workspaceId, agentId] = params;
        const moved = db.jobs.filter((job) => job.status === 'running'
          && job.workspace_id === workspaceId
          && job.agent_id === agentId
          && job.connection_id !== connectionId);
        for (const job of moved) job.connection_id = connectionId;
        // Only record re-homings that actually moved something: every register
        // runs this statement, and a no-op is not an event worth asserting on.
        if (moved.length > 0) db.rehomes.push({ connectionId, moved: moved.map((job) => job.id) });
        return moved.map((job) => ({ id: job.id }));
      }
      if (text.startsWith('select * from agent_jobs where connection_id')) {
        db.failureSweeps.push(params[0]);
        return db.jobs.filter((job) => job.connection_id === params[0] && job.status === 'running');
      }
      if (text.startsWith("update agent_permission_requests set status = 'expired'")) return [];
      if (text.startsWith('insert into activity_events')) return [];
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  return db;
}

async function register(ws) {
  await __test.registerAgentConnection(ws, {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    handle: 'coder',
    name: 'Coder',
    host: 'example-host.local',
    cwd: '/Users/alice/Documents/GitHub/agensis',
  });
  await new Promise((resolve) => setImmediate(resolve));
}

// A turn only exists once the daemon is registered, so the fixture adds it after
// the first register rather than pre-seeding it onto a connection that has no id.
function startJob(db, ws) {
  const job = {
    id: 'job-1',
    workspace_id: WORKSPACE,
    agent_id: AGENT,
    status: 'running',
    connection_id: ws.agentConnectionId,
  };
  db.jobs.push(job);
  return job;
}

test('an unexplained drop does not fail the running turn on the spot', async () => {
  const db = dropDb();
  __test.setTestDb(db);

  const ws = agentSocket('first');
  await register(ws);
  const job = startJob(db, ws);

  // The socket dies the way terminate() kills it — no eviction, nobody told the
  // daemon anything. The turn is still executing on the other end.
  await __test.markAgentConnectionOffline(ws);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(db.failureSweeps, [], 'the turn is given the reconnect window, not killed');
  assert.equal(job.status, 'running');
});

test('reconnecting inside the window keeps the turn and re-homes it', async () => {
  const db = dropDb();
  __test.setTestDb(db);

  const first = agentSocket('first');
  await register(first);
  const job = startJob(db, first);
  const droppedConnectionId = first.agentConnectionId;

  await __test.markAgentConnectionOffline(first);
  await new Promise((resolve) => setImmediate(resolve));

  // ~2s later the same daemon is back on a fresh socket.
  const second = agentSocket('second');
  await register(second);

  assert.deepEqual(db.failureSweeps, [], 'nothing was failed across the drop');
  assert.equal(job.status, 'running', 'the turn survives the blip');
  assert.equal(
    job.connection_id,
    second.agentConnectionId,
    'the job now points at the connection that exists',
  );
  assert.notEqual(job.connection_id, droppedConnectionId);
  assert.equal(db.rehomes.length, 1);
  assert.deepEqual(db.rehomes[0].moved, ['job-1']);
});


// A daemon is a Node process that shells out. While it pipes `npx vite build` or
// `npx vitest run` stdout its event loop stalls — and a pong is answered ON that
// loop. At 2 missed pongs (~30s) the server terminated HEALTHY daemons mid-turn,
// fired failConnectionJobs, and destroyed the work (observed live 2026-07-29:
// job 4c065aaa, killed at 6m07s with "the daemon disconnected", mid-build).
//
// Pinned as a floor, not an exact value: the point is that a busy daemon gets
// substantially more than half a minute before it is declared dead.
test('a daemon busy in a long build is not killed inside two minutes', () => {
  assert.ok(
    __test.LIVENESS_MAX_MISSED_PONGS * __test.LIVENESS_PING_INTERVAL_MS >= 120_000,
    `a stalled-but-healthy daemon must get >=120s, got ${
      (__test.LIVENESS_MAX_MISSED_PONGS * __test.LIVENESS_PING_INTERVAL_MS) / 1000}s`,
  );
});

test('a socket that answers even once mid-build resets its whole budget', () => {
  const ws = livenessSocket('busy-build');
  // Stall for one tick short of termination…
  for (let i = 0; i < __test.LIVENESS_MAX_MISSED_PONGS - 1; i += 1) __test.sweepLiveness([ws]);
  assert.equal(ws.terminated, false, 'not dead yet');
  // …then the child process finishes and the loop drains the queued ping.
  ws.pong();
  __test.sweepLiveness([ws]);
  assert.equal(ws.missedPongs, 0, 'the budget resets, so back-to-back builds never accumulate');
  assert.equal(ws.terminated, false);
});
