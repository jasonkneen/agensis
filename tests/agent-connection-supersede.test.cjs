'use strict';

// ONE live daemon connection per agent.
//
// Production had TWO live connections for the same agent, from the same host and
// cwd, both heartbeating in the same second: two real daemons, not a stale row.
// `agent_register` did not evict an existing live connection, so both persisted.
// Dispatch was never double-served (findConnectedAgent returns the FIRST match),
// but the roster showed the agent twice, one daemon sat there heartbeating and
// was never given work, and which connection won was Map-insertion order.
//
// The rule under test: registering supersedes any OLDER live connection for the
// same agent. Newest wins, the loser is told why on the way out, and the
// invariant that must hold after every register is "exactly one live entry for
// this agent".
//
// The reconnect case is the whole risk, so it is tested from both ends: a daemon
// that reconnects on a NEW socket must end up online (not evicted into nothing),
// and a daemon that re-registers on the SAME socket must not close itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const WORKSPACE = 'ws-1';
const AGENT = 'agent-scout';

const agentRow = (overrides = {}) => ({
  id: AGENT,
  name: 'Scout',
  avatar: 'SC',
  accent_color: '',
  description: '',
  soul: '',
  identity: {},
  enabled: true,
  version: 1,
  ...overrides,
});

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

// A socket that records what it was told and stops accepting sends once closed,
// the way a real ws does.
function fakeSocket(label) {
  return {
    label,
    readyState: 1,
    isAlive: true,
    sent: [],
    closed: null,
    send(payload) {
      this.sent.push(JSON.parse(payload));
    },
    close(code, reason) {
      this.closed = { code, reason };
      this.readyState = 3;
    },
    messages(type) {
      return this.sent.filter((message) => message.type === type);
    },
  };
}

function agentSocket(label, { workspaceId = WORKSPACE, agentId = AGENT } = {}) {
  const ws = fakeSocket(label);
  ws.agentAuth = {
    workspaceId,
    agentId,
    handle: 'scout',
    name: 'Scout',
    agent: { id: agentId, name: 'Scout', handle: 'scout' },
  };
  return ws;
}

// Fake DB covering exactly the statements a register (and the eviction it may
// trigger) runs. Records the connection rows so a test can see which survived.
function connectionDb({ agents = { [AGENT]: agentRow() }, runningJobs = [] } = {}) {
  const rows = new Map();
  const log = [];
  const db = {
    rows,
    log,
    liveIds: () => [...rows.values()].filter((row) => row.status !== 'offline').map((row) => row.id),
    async unsafe(sql, params = []) {
      const text = norm(sql);
      log.push(text);

      if (text.startsWith('select id, name, avatar')) {
        const agent = agents[String(params[0])];
        return agent ? [agent] : [];
      }
      if (text.startsWith("delete from agent_connections where workspace_id")) {
        const deleted = [...rows.values()].filter((row) => row.workspace_id === params[0]
          && row.agent_id === params[1]
          && row.status === 'offline');
        for (const row of deleted) rows.delete(row.id);
        return deleted;
      }
      if (text.startsWith('insert into agent_connections')) {
        const [id, workspace_id, agent_id, name, handle, host, cwd, , metadata] = params;
        const row = {
          id,
          workspace_id,
          agent_id,
          name,
          handle,
          host,
          cwd,
          status: 'online',
          metadata,
          capabilities: {},
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
      if (text.startsWith('delete from agent_connections where id = any')) {
        const ids = params[0] || [];
        const deleted = [];
        for (const id of ids) {
          const row = rows.get(id);
          if (!row) continue;
          deleted.push(row);
          rows.delete(id);
        }
        return deleted;
      }
      if (text.startsWith('select * from agent_jobs where connection_id')) {
        return runningJobs.filter((job) => job.connection_id === params[0]);
      }
      // A disconnecting daemon's parked tool approvals expire with its jobs —
      // the process that would act on an answer is gone. No pending rows in
      // this fixture, so it returns none; the point is that the sweep is part
      // of the disconnect path and not an unexpected write.
      if (text.startsWith('update agent_permission_requests set status = \'expired\'')) {
        return [];
      }
      if (text.startsWith('insert into activity_events')) {
        return [];
      }
      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  return db;
}

// Registers and then waits a macrotask, so the fire-and-forget bookkeeping the
// register kicks off (job failure sweep, activity log) has run before we assert.
async function register(ws, message = {}) {
  await __test.registerAgentConnection(ws, {
    workspaceId: WORKSPACE,
    agentId: AGENT,
    handle: 'scout',
    name: 'Scout',
    host: 'morphvm',
    cwd: '/root',
    ...message,
  });
  await new Promise((resolve) => setImmediate(resolve));
}

const liveFor = (agentId) => __test.listTestConnectedAgents()
  .filter((entry) => String(entry.agentId) === String(agentId));

test('a second register for the same agent evicts the first, leaving ONE live connection', async () => {
  const db = connectionDb();
  __test.setTestDb(db);

  const first = agentSocket('first');
  const second = agentSocket('second');

  await register(first);
  assert.equal(liveFor(AGENT).length, 1, 'first register is the only live connection');

  await register(second);

  const live = liveFor(AGENT);
  assert.equal(live.length, 1, 'a second register leaves exactly one live connection');
  assert.equal(live[0].ws, second, 'the NEWEST connection is the one kept');

  // The loser is closed, not left dangling.
  assert.equal(first.readyState, 3, 'the superseded socket is closed');
  assert.equal(second.readyState, 1, 'the winning socket stays open');

  // And its roster row is gone, so the agent is not listed twice.
  assert.deepEqual(db.liveIds(), [second.agentConnectionId]);
  assert.equal(db.rows.size, 1, 'the superseded connection row is deleted, not left offline');
});

test('the evicted socket is told WHY, on both the message and the close frame', async () => {
  __test.setTestDb(connectionDb());

  const first = agentSocket('first');
  const second = agentSocket('second');
  await register(first);
  await register(second);

  const disabled = first.messages('agent_disabled');
  assert.equal(disabled.length, 1, 'the evicted daemon gets exactly one agent_disabled');
  assert.equal(disabled[0].reason, 'superseded', 'the reason names the cause, not a generic drop');

  assert.equal(first.closed.code, 1008);
  assert.equal(
    first.closed.reason,
    __test.AGENT_DISCONNECT_CLOSE_MESSAGES.superseded,
    'the close frame carries operator-readable text, so this is not debugged as a network fault',
  );
  assert.match(first.closed.reason, /newer connection/i);

  assert.equal(second.messages('agent_disabled').length, 0, 'the winner is not told anything of the sort');
  assert.equal(second.messages('agent_registered').length, 1);
});

test('a reconnect from the same daemon ends up ONLINE, not evicted into nothing', async () => {
  const db = connectionDb();
  __test.setTestDb(db);

  const original = agentSocket('original');
  await register(original);
  const firstConnectionId = original.agentConnectionId;

  // The half-open case: the daemon's socket died on its side and it reconnected,
  // but the server has not noticed yet — the zombie is still readyState 1 and
  // still in the map. This is the ordinary flaky-network / laptop-sleep path.
  const reconnected = agentSocket('reconnected');
  await register(reconnected);

  const live = liveFor(AGENT);
  assert.equal(live.length, 1, 'a reconnect does not stack a second connection');
  assert.equal(live[0].ws, reconnected, 'the agent is ONLINE on the new socket');
  assert.equal(live[0].connectionId, reconnected.agentConnectionId);
  assert.notEqual(reconnected.agentConnectionId, firstConnectionId);
  assert.equal(
    __test.findConnectedAgent(WORKSPACE, AGENT, 'scout')?.ws,
    reconnected,
    'dispatch resolves the agent to the live socket',
  );
  assert.equal(db.rows.get(reconnected.agentConnectionId).status, 'online');
});

test('re-registering on the SAME socket does not evict itself', async () => {
  const db = connectionDb();
  __test.setTestDb(db);

  const ws = agentSocket('only');
  await register(ws);
  const firstConnectionId = ws.agentConnectionId;

  await register(ws);

  const live = liveFor(AGENT);
  assert.equal(live.length, 1, 'still exactly one live connection');
  assert.equal(live[0].ws, ws);
  assert.equal(ws.readyState, 1, 'the socket that re-registered is NOT closed');
  assert.equal(ws.closed, null);
  assert.equal(ws.messages('agent_disabled').length, 0);
  assert.equal(ws.agentConnectionId, live[0].connectionId, 'the ws points at its current connection row');
  assert.notEqual(ws.agentConnectionId, firstConnectionId, 'a fresh row per register, as before');
  assert.equal(db.liveIds().length, 1, 'and one live row in the roster');
});

test('two agents with different ids do not evict each other', async () => {
  const OTHER = 'agent-coder';
  const db = connectionDb({ agents: { [AGENT]: agentRow(), [OTHER]: agentRow({ id: OTHER, name: 'Coder' }) } });
  __test.setTestDb(db);

  const scout = agentSocket('scout');
  const coder = agentSocket('coder', { agentId: OTHER });

  await register(scout);
  await __test.registerAgentConnection(coder, {
    workspaceId: WORKSPACE,
    agentId: OTHER,
    handle: 'coder',
    name: 'Coder',
    host: 'morphvm',
    cwd: '/root',
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(liveFor(AGENT).length, 1);
  assert.equal(liveFor(OTHER).length, 1);
  assert.equal(scout.readyState, 1, 'registering another agent does not close this one');
  assert.equal(scout.closed, null);
  assert.equal(scout.messages('agent_disabled').length, 0);

  // Superseding one agent leaves the other alone.
  await register(agentSocket('scout-2'));
  assert.equal(scout.readyState, 3, 'the same agent WAS superseded');
  assert.equal(coder.readyState, 1, 'the other agent is untouched');
  assert.equal(liveFor(OTHER).length, 1);
  assert.equal(db.rows.get(coder.agentConnectionId).status, 'online');
});

test('a superseded connection has its in-flight job failed, like any disconnect', async () => {
  const db = connectionDb({ runningJobs: [] });
  __test.setTestDb(db);

  const first = agentSocket('first');
  await register(first);
  // The job belongs to the connection about to be superseded. Its results could
  // only ever come back on that dead socket, so it must not be left running.
  db.log.length = 0;
  const jobs = [{ id: 'job-1', connection_id: first.agentConnectionId, status: 'running' }];
  const dbWithJob = connectionDb({ runningJobs: jobs });
  dbWithJob.rows.set(first.agentConnectionId, db.rows.get(first.agentConnectionId));
  __test.setTestDb(dbWithJob);

  await register(agentSocket('second'));

  assert.ok(
    dbWithJob.log.some((sql) => sql.startsWith('select * from agent_jobs where connection_id')),
    'the superseded connection goes through the normal offline sweep for its jobs',
  );
});

test('disconnectAgentDaemons still closes every connection for the agent (deactivate path)', async () => {
  const db = connectionDb();
  __test.setTestDb(db);

  const ws = agentSocket('only');
  await register(ws);

  await __test.disconnectAgentDaemons(AGENT, WORKSPACE, 'deactivated');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(liveFor(AGENT).length, 0);
  assert.equal(ws.closed.code, 1008);
  assert.equal(ws.closed.reason, __test.AGENT_DISCONNECT_CLOSE_MESSAGES.deactivated);
  assert.equal(ws.messages('agent_disabled')[0].reason, 'deactivated');
  // Deactivation keeps its existing behaviour: the row goes offline and is
  // pruned later, rather than being deleted out from under the roster.
  assert.equal(db.rows.get(ws.agentConnectionId).status, 'offline');
});

test('takeAgentDaemonConnections is synchronous, so take -> set cannot interleave', () => {
  __test.setTestDb(connectionDb());
  const first = { ws: fakeSocket('a'), connectionId: 'c-1', workspaceId: WORKSPACE, agentId: AGENT };
  const other = { ws: fakeSocket('b'), connectionId: 'c-2', workspaceId: WORKSPACE, agentId: 'agent-other' };
  __test.registerTestConnectedAgent(first);
  __test.registerTestConnectedAgent(other);

  const taken = __test.takeAgentDaemonConnections(AGENT, WORKSPACE);

  assert.deepEqual(taken.map((entry) => entry.connectionId), ['c-1']);
  assert.equal(liveFor(AGENT).length, 0, 'removed from the map before any await');
  assert.equal(liveFor('agent-other').length, 1, 'other agents untouched');
  assert.equal(first.ws.closed, null, 'taking does not close — phase 2 does');
});
