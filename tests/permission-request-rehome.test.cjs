'use strict';

// A socket blip must not throw away a question a human is still looking at.
//
// 2026-07-29, live: job baecd4b2 raised an Edit approval at 07:42:30 with the
// default ten-minute TTL. Its daemon's socket blipped and it reconnected at
// 07:43:59 — ninety seconds in, eight minutes of TTL still on the clock. The
// human's card was already dead, because socket close expired EVERY pending
// request on that connection outright, and the agent went on to tell them the
// call "could no longer be approved".
//
// Running jobs already survived this (rehomeRunningJobs, agent-jobs.cjs) —
// permission requests had no equivalent.
//
// THE ORDERING PROBLEM this file pins. Close fires before the reconnect
// registers, so anything that expires on close has already destroyed the rows by
// the time a re-home could run. The fix is not "expire later and hope": it is
//
//   1. close DEFERS the expiry onto the same reconnect grace window the jobs use,
//   2. the daemon RE-ASSERTS the request ids it is still parked on at register,
//   3. registration re-homes exactly those, THEN expires whatever is left.
//
// WHY RE-ASSERTION AND NOT "THE AGENT RECONNECTED". The register frame carries no
// process identity, so a two-second blip and a full daemon restart are
// indistinguishable at the socket. Only the process still holding the parked
// promise can name its id. Re-homing on agent identity alone would point the row
// at a process with no memory of the request: its decide() drops the frame, while
// the server has already recorded "Allowed" and rewritten the transcript. That is
// precisely the "approved under a tool call that never ran" failure
// deliverDecision exists to prevent, so the whole design fails closed — an
// unasserted request expires, and the cost of that is one extra prompt.
//
// THE DELIVERY INVARIANT IS UNCHANGED AND LOAD-BEARING. A decision still goes to
// the EXACT connection named on the row and nowhere else. That is what makes the
// deferral safe for daemons that never re-assert: their row stays pending on a
// connection id that is no longer in the live map, so a click inside the window
// is refused with the existing 409 rather than recorded against a daemon that
// cannot act on it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const WORKSPACE = 'ws-1';
const AGENT = 'agent-coder';
const OTHER_AGENT = 'agent-scout';

const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

function agentSocket(label, agentId = AGENT) {
  const ws = {
    label,
    readyState: 1,
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() { this.readyState = 3; },
  };
  ws.agentAuth = {
    workspaceId: WORKSPACE,
    agentId,
    handle: 'coder',
    name: 'Coder',
    agent: { id: agentId, name: 'Coder', handle: 'coder' },
  };
  return ws;
}

function permissionRow(overrides = {}) {
  return {
    id: 'req-1',
    workspace_id: WORKSPACE,
    agent_id: AGENT,
    job_id: 'job-1',
    connection_id: null,
    session_id: 'session-1',
    message_id: 'msg-1',
    request_key: 'daemon-req-1',
    tool_name: 'Edit',
    tool_detail: 'src/index.css',
    rules: [],
    scopes: ['once', 'session'],
    status: 'pending',
    scope: '',
    // Eight minutes left, exactly like the incident.
    expires_at: new Date(Date.now() + 8 * 60_000).toISOString(),
    ...overrides,
  };
}

// A store, not a stub. The two statements under test are executed against real
// rows so a test can assert what a row ENDED UP as, rather than that a mock was
// called — a mock that answered these by fiat would be testing itself.
function permissionDb({ requests = [] } = {}) {
  const connections = new Map();
  const db = {
    requests,
    connections,
    // Every agent_permission_requests statement, in order, so the ordering fix
    // (re-home strictly before expire) is checkable rather than assumed.
    statements: [],
    async unsafe(sql, params = []) {
      const text = norm(sql);

      if (text.startsWith('select id, name, avatar')) {
        return [{
          id: params[0], name: 'Coder', avatar: 'CO', accent_color: '', description: '',
          soul: '', identity: {}, run_mode: 'daemon', metadata: {}, enabled: true, version: 1,
        }];
      }
      if (text.startsWith('delete from agent_connections where workspace_id')) return [];
      if (text.startsWith('insert into agent_connections')) {
        const [id, workspace_id, agent_id, name, handle, host, cwd, metadata] = params;
        const row = {
          id, workspace_id, agent_id, name, handle, host, cwd,
          status: 'online', metadata, capabilities: {},
        };
        connections.set(id, row);
        return [row];
      }
      if (text.startsWith('update agent_connections set status =')) {
        const row = connections.get(params[0]);
        if (!row) return [];
        row.status = 'offline';
        return [row];
      }
      if (text.startsWith('delete from agent_connections where id = any')) {
        for (const id of params[0]) connections.delete(id);
        return [];
      }
      if (text.startsWith('update agent_jobs set connection_id')) return [];
      if (text.startsWith('select * from agent_jobs where connection_id')) return [];
      if (text.startsWith('insert into activity_events')) return [];

      // --- the two statements this file exists for ---------------------------

      if (text.startsWith('update agent_permission_requests set connection_id')) {
        const [connectionId, workspaceId, agentId, keys] = params;
        db.statements.push({ kind: 'rehome', connectionId, keys: [...keys] });
        // The guards are read OUT OF the statement rather than re-implemented
        // here. Spelling them out in the fixture is how a WHERE-clause test goes
        // vacuous: delete `and agent_id = $3` from the real query and a mock that
        // filters by agent anyway still returns one row, so the isolation test
        // passes while the isolation is gone. Deriving them means the fixture
        // stops enforcing whatever the query stops asking for.
        const asks = {
          workspace: text.includes('workspace_id = $2'),
          agent: text.includes('agent_id = $3'),
          pending: text.includes("status = 'pending'"),
          ttl: text.includes('expires_at > now()'),
          keys: text.includes('request_key = any($4::text[])'),
        };
        const moved = db.requests.filter((row) => (!asks.workspace || row.workspace_id === workspaceId)
          && (!asks.agent || row.agent_id === agentId)
          && (!asks.pending || row.status === 'pending')
          && (!asks.ttl || !row.expires_at || new Date(row.expires_at).getTime() > Date.now())
          && (!asks.keys || keys.includes(row.request_key))
          && row.connection_id !== connectionId);
        for (const row of moved) row.connection_id = connectionId;
        return moved.map((row) => ({ ...row }));
      }
      if (text.startsWith("update agent_permission_requests set status = 'expired'")) {
        // Both the by-connection sweep and the global TTL sweep normalise to this
        // prefix; only the by-connection one binds a parameter.
        const connectionId = params[0];
        db.statements.push({ kind: 'expire', connectionId });
        const hit = db.requests.filter((row) => row.status === 'pending' && row.connection_id === connectionId);
        for (const row of hit) row.status = 'expired';
        return hit.map((row) => ({ ...row }));
      }
      if (text.startsWith('update messages set content')) return [{ id: params[0], content: params[1] }];

      // decideAgentPermissionRequest's own reads, so the delivery invariant can
      // be exercised end to end rather than asserted about in the abstract.
      if (text.startsWith('select * from agent_permission_requests where id')) {
        const row = db.requests.find((entry) => entry.id === params[0] && entry.workspace_id === params[1]);
        return row ? [{ ...row }] : [];
      }
      if (text.startsWith('update agent_permission_requests set status = $2')) {
        const row = db.requests.find((entry) => entry.id === params[0] && entry.status === 'pending');
        if (!row) return [];
        row.status = params[1];
        row.scope = params[2];
        return [{ ...row }];
      }
      if (text.startsWith('select display_name, email from app_users')) return [{ display_name: 'Jason', email: 'j@x.io' }];
      if (text.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [{ '?column?': 1 }];

      throw new Error(`Unexpected SQL: ${text}`);
    },
  };
  return db;
}

async function register(ws, { permissionRequestIds } = {}) {
  await __test.registerAgentConnection(ws, {
    workspaceId: WORKSPACE,
    agentId: ws.agentAuth.agentId,
    handle: 'coder',
    name: 'Coder',
    host: 'OzBook-M3-5.local',
    cwd: '/Users/jkneen/Documents/GitHub/agensis',
    ...(permissionRequestIds ? { permissionRequestIds } : {}),
  });
  await settle();
}

// markConnectionOffline fires its cleanups with `void`, so a tick has to pass
// before their effects can be asserted either way.
const settle = () => new Promise((resolve) => setImmediate(resolve));

const registeredFrame = (ws) => ws.sent.find((frame) => frame.type === 'agent_registered');

// --- the drop -----------------------------------------------------------------

test('an unexplained drop does not expire the parked request on the spot', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const ws = agentSocket('first');
  await register(ws);
  db.requests[0].connection_id = ws.agentConnectionId;

  // The socket dies the way terminate() kills it: no eviction, nobody told the
  // daemon anything, and the turn is still executing on the other end.
  await __test.markAgentConnectionOffline(ws);
  await settle();

  assert.equal(db.requests[0].status, 'pending', 'a blip must not kill a question with eight minutes left on it');
  assert.deepEqual(
    db.statements.filter((entry) => entry.kind === 'expire'),
    [],
    'the expiry is deferred to the reconnect grace window, not run inline on close',
  );
});

test('a request stranded on a dead connection cannot be decided', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const ws = agentSocket('first');
  await register(ws);
  const droppedConnectionId = ws.agentConnectionId;
  db.requests[0].connection_id = droppedConnectionId;

  await __test.markAgentConnectionOffline(ws);
  await settle();

  // The row is still pending, which is the point of the deferral — but the
  // connection it names is gone from the live map, so the decision is refused
  // rather than recorded. This is what makes holding the row safe.
  assert.equal(
    __test.listTestConnectedAgents().some((entry) => entry.connectionId === droppedConnectionId),
    false,
    'the dead connection is out of the dispatch map',
  );
  await assert.rejects(
    () => __test.decideAgentPermissionRequest({
      userId: 'user-1', workspaceId: WORKSPACE, requestId: 'req-1', behavior: 'allow', scope: 'once',
    }),
    (error) => error.code === 'agent_offline',
    'a click on a stranded card must not record an approval nobody can act on',
  );
  assert.equal(db.requests[0].status, 'pending', 'and it certainly must not be marked allowed');
});

// --- the reconnect ------------------------------------------------------------

test('a daemon that re-asserts its parked id keeps the request answerable', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const first = agentSocket('first');
  await register(first);
  db.requests[0].connection_id = first.agentConnectionId;

  await __test.markAgentConnectionOffline(first);
  await settle();

  const second = agentSocket('second');
  await register(second, { permissionRequestIds: ['daemon-req-1'] });

  assert.equal(db.requests[0].status, 'pending', 'the request survives the blip');
  assert.equal(
    db.requests[0].connection_id,
    second.agentConnectionId,
    'and now points at the connection that can actually deliver a decision',
  );
  assert.deepEqual(
    registeredFrame(second).resumedPermissionRequests,
    ['daemon-req-1'],
    'the daemon is told which parks survived, so it keeps waiting on exactly those',
  );
});

test('the re-home runs before the stale sweep, or there is nothing left to save', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const first = agentSocket('first');
  await register(first);
  db.requests[0].connection_id = first.agentConnectionId;
  await __test.markAgentConnectionOffline(first);
  await settle();

  db.statements.length = 0;
  const second = agentSocket('second');
  await register(second, { permissionRequestIds: ['daemon-req-1'] });

  const kinds = db.statements.map((entry) => entry.kind);
  assert.ok(kinds.includes('rehome') && kinds.includes('expire'), 'the reconnect does both');
  assert.ok(
    kinds.indexOf('rehome') < kinds.indexOf('expire'),
    'expiring first is the original bug: it destroys the rows the re-home was for',
  );
});

test('a daemon that re-asserts nothing gets the old behaviour — the request expires', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const first = agentSocket('first');
  await register(first);
  db.requests[0].connection_id = first.agentConnectionId;
  await __test.markAgentConnectionOffline(first);
  await settle();

  // A restarted daemon, or any daemon older than this change: it names nothing,
  // so nothing is presumed about it.
  const second = agentSocket('second');
  await register(second);

  assert.equal(db.requests[0].status, 'expired', 'an unclaimed park is not answerable and must stop looking like it is');
  assert.deepEqual(
    registeredFrame(second).resumedPermissionRequests,
    [],
    'and the daemon is told nothing was kept, so it denies its own parks instead of hanging',
  );
});

// --- what re-assertion is NOT allowed to reach --------------------------------

test('only the ids the daemon actually named are re-homed', async () => {
  const claimed = permissionRow();
  const forgotten = permissionRow({ id: 'req-9', request_key: 'daemon-req-9' });
  const db = permissionDb({ requests: [claimed, forgotten] });
  __test.setTestDb(db);

  const first = agentSocket('first');
  await register(first);
  claimed.connection_id = first.agentConnectionId;
  forgotten.connection_id = first.agentConnectionId;
  await __test.markAgentConnectionOffline(first);
  await settle();

  // The turn holding req-9 finished during the outage; only req-1 is still
  // parked. "The agent reconnected" is not a claim about req-9.
  const second = agentSocket('second');
  await register(second, { permissionRequestIds: ['daemon-req-1'] });

  assert.equal(claimed.connection_id, second.agentConnectionId, 'the named park moves');
  assert.equal(forgotten.status, 'expired', 'the unnamed one is given up on, not carried along for the ride');
  assert.deepEqual(registeredFrame(second).resumedPermissionRequests, ['daemon-req-1']);
});

test('an expired request is not revived by re-asserting it', async () => {
  const db = permissionDb({ requests: [permissionRow({ status: 'expired' })] });
  __test.setTestDb(db);

  const ws = agentSocket('restarted');
  await register(ws, { permissionRequestIds: ['daemon-req-1'] });

  assert.equal(db.requests[0].status, 'expired', 'the human already saw this close; it does not reopen');
  assert.equal(db.requests[0].connection_id, null, 'and it is not quietly re-pointed at the live daemon either');
  assert.deepEqual(registeredFrame(ws).resumedPermissionRequests, []);
});

test('a request past its TTL is not revived by re-asserting it', async () => {
  const db = permissionDb({
    requests: [permissionRow({ expires_at: new Date(Date.now() - 60_000).toISOString() })],
  });
  __test.setTestDb(db);

  const ws = agentSocket('slow');
  await register(ws, { permissionRequestIds: ['daemon-req-1'] });

  assert.equal(db.requests[0].connection_id, null, 'the TTL is a real deadline, not one a reconnect can extend');
  assert.deepEqual(registeredFrame(ws).resumedPermissionRequests, []);
});

test('a daemon cannot re-assert another agent’s request', async () => {
  const mine = permissionRow();
  const theirs = permissionRow({ id: 'req-2', agent_id: OTHER_AGENT, request_key: 'daemon-req-2' });
  const db = permissionDb({ requests: [mine, theirs] });
  __test.setTestDb(db);

  const ws = agentSocket('greedy');
  // The socket's token says agent-coder; the frame claims both keys.
  await register(ws, { permissionRequestIds: ['daemon-req-1', 'daemon-req-2'] });

  assert.equal(mine.connection_id, ws.agentConnectionId, 'its own park is re-homed');
  assert.equal(theirs.connection_id, null, 'another agent’s park is not reachable by naming its id');
  assert.deepEqual(
    registeredFrame(ws).resumedPermissionRequests,
    ['daemon-req-1'],
    'and the acknowledgement never confirms a request that was not moved',
  );
});

// --- evictions ----------------------------------------------------------------

test('a supersede hands the parks to the registering connection instead of killing them', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  // A half-open drop: the server still holds the zombie, so the daemon's
  // reconnect SUPERSEDES it rather than arriving after a clean close. That path
  // evicts, and eviction used to expire the parks before the re-home could run.
  const zombie = agentSocket('half-open');
  await register(zombie);
  db.requests[0].connection_id = zombie.agentConnectionId;

  const fresh = agentSocket('reconnect');
  await register(fresh, { permissionRequestIds: ['daemon-req-1'] });

  assert.equal(db.requests[0].status, 'pending');
  assert.equal(db.requests[0].connection_id, fresh.agentConnectionId);
  assert.deepEqual(registeredFrame(fresh).resumedPermissionRequests, ['daemon-req-1']);
});

test('a deliberate eviction still expires the parks immediately', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const ws = agentSocket('deactivated');
  await register(ws);
  db.requests[0].connection_id = ws.agentConnectionId;

  // Deactivating the agent tells that daemon to stop, terminally. Nothing is
  // coming back, so the human must not be left holding a live-looking button.
  await __test.disconnectAgentDaemons(AGENT, WORKSPACE, 'deactivated');
  await settle();

  assert.equal(db.requests[0].status, 'expired');
});

// --- input handling -----------------------------------------------------------

test('a malformed re-assertion list cannot reach the query', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const ws = agentSocket('junk');
  await register(ws, { permissionRequestIds: 'daemon-req-1' });

  assert.deepEqual(
    db.statements.filter((entry) => entry.kind === 'rehome'),
    [],
    'a non-array from an untrusted socket is not iterated into a bind',
  );
  assert.deepEqual(registeredFrame(ws).resumedPermissionRequests, []);
});

test('a flood of re-asserted ids is bounded and de-duplicated', async () => {
  const db = permissionDb({ requests: [permissionRow()] });
  __test.setTestDb(db);

  const ws = agentSocket('flood');
  const flood = ['daemon-req-1', 'daemon-req-1', ...Array.from({ length: 500 }, (_, i) => `spam-${i}`)];
  await register(ws, { permissionRequestIds: flood });

  const rehome = db.statements.find((entry) => entry.kind === 'rehome');
  assert.ok(rehome, 'the real key still gets through');
  assert.ok(rehome.keys.length <= 64, `bound the array a daemon can put in an = any() bind, got ${rehome.keys.length}`);
  assert.equal(rehome.keys.filter((key) => key === 'daemon-req-1').length, 1, 'duplicates collapse');
  assert.equal(db.requests[0].connection_id, ws.agentConnectionId);
});
