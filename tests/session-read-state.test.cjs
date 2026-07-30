'use strict';

// ============================================================================
// tests/session-read-state.test.cjs
// ----------------------------------------------------------------------------
// Read receipts: POST /backend/sessions/:id/read and
// GET /backend/sessions/:id/read-state.
//
// A receipt publishes behaviour — WHO read WHAT, and WHEN. That is a different
// disclosure from anything else this product emits, so most of this file is
// about what the routes REFUSE rather than what they store.
//
// FOUR PROPERTIES, and why each one is a route rather than a convention:
//
//   1. `user_id` is req.userId. A generic insert would let anyone claim anyone
//      read anything, which is a fabricated social signal about another person.
//   2. `read_at` is resolved from the named message's own `created_at`. The
//      client sends an ID, never a timestamp, so markers and messages share ONE
//      clock. A receipt has no TTL to hide skew in, and a fast browser clock
//      would otherwise mark messages read that arrived after the reader left.
//   3. The marker only ever moves FORWARD. A slow write from a second device
//      cannot un-read something.
//   4. The opt-out is RECIPROCAL and server-side: switching receipts off means
//      your marker is never STORED (nothing left behind to leak later) and you
//      stop seeing everyone else's.
//
// WHAT THE MOCK IS ALLOWED TO DO. It stands in for Postgres — it honours the
// parameters it is given and reports what statements ran. It does NOT re-decide
// any authorization rule, and it does not implement the monotonic guard: that
// guard is a property of the SQL, so it is asserted against the statement rather
// than against a fake that could agree with itself.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');
const {
  ADVANCE_READ_MARKER_SQL,
  SESSION_READ_STATE_SQL,
} = require('../shared/read-receipts.cjs');
const {
  ALLOWED_TABLES,
  DB_TABLE_ACCESS,
  SELECTABLE_COLUMNS_BY_TABLE,
  WORKSPACE_SCOPED_TABLES,
} = require('../shared/backend-core.cjs');

const OWNER = 'owner-1';
const MEMBER = 'member-1';
const OUTSIDER = 'outsider-1';
const WORKSPACE = 'w1';
const CHANNEL = 'chan-1';
const DM = 'dm-1';
const MESSAGE = 'msg-1';
const OTHER_SESSION_MESSAGE = 'msg-elsewhere';

test.afterEach(() => __test.resetTestState());

function makeDb({ roles = {}, dmMembers = [], markers = [], optedOut = [] } = {}) {
  const sql = [];
  const written = [];
  const db = {
    sql,
    written,
    async unsafe(text, params = []) {
      const n = String(text).replace(/\s+/g, ' ').trim();
      const q = n.toLowerCase();
      sql.push({ sql: n, q, params });

      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'receipts-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.includes('union all') && q.includes('workspace_members where workspace_id = $1 and user_id = $2')) {
        const uid = String(params[1]);
        return uid === OWNER || roles[uid] ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select 1 from workspaces where id')) {
        return String(params[1]) === OWNER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) {
        const role = roles[String(params[1])];
        return role ? [{ role }] : [];
      }
      if (q.includes('with recursive chain as')) return [];
      // resolveOperationWorkspace's session lookup: `session_read_state` has no
      // workspace_id column, so the generic path can only reach a tenant through
      // the session named in the filter. That indirection IS the scoping.
      if (q.startsWith('select workspace_id from chat_sessions where id')) {
        const id = String(params[0]);
        return id === CHANNEL || id === DM ? [{ workspace_id: WORKSPACE }] : [];
      }
      // Two spellings of "load the session", and they are NOT interchangeable:
      // the routes select the workspace too (one query, both gates), while
      // enforceSessionReadAccess loads only what the privacy rule reads. Both
      // must answer, or a gate silently passes on a session it never found.
      if (q.startsWith('select id, workspace_id, visibility, folder from chat_sessions')
        || q.startsWith('select id, visibility, folder from chat_sessions')) {
        if (String(params[0]) === CHANNEL) {
          return [{ id: CHANNEL, workspace_id: WORKSPACE, visibility: 'workspace', folder: 'General' }];
        }
        if (String(params[0]) === DM) {
          return [{ id: DM, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages' }];
        }
        return [];
      }
      if (q.startsWith('select 1 from chat_session_members')) {
        return dmMembers.includes(String(params[1])) ? [{ ok: 1 }] : [];
      }

      // The marker upsert. The mock honours the two things the STATEMENT says:
      // the message must belong to the named session, and the writer must not
      // have opted out. Both are in the statement's own WHERE, so this is
      // reporting what the parameters make true, not inventing a rule.
      if (q.startsWith('insert into session_read_state')) {
        const [sessionId, userId, messageId] = params.map(String);
        if (optedOut.includes(userId)) return [];
        if (messageId !== MESSAGE) return [];           // `m.id = $3`
        if (sessionId !== CHANNEL && sessionId !== DM) return [];
        written.push({ sessionId, userId, messageId });
        return [{ session_id: sessionId, user_id: userId, read_at: '2026-07-01T00:00:00.000Z' }];
      }

      if (q.startsWith('select r.session_id, r.user_id, r.read_at')) {
        const [sessionId, callerId] = params.map(String);
        // Reciprocity and the omission of opted-out readers are BOTH in the
        // statement's WHERE; the mock applies the caller's own flag and each
        // row's flag exactly as those predicates would.
        if (optedOut.includes(callerId)) return [];
        return markers
          .filter(marker => marker.session_id === sessionId && !optedOut.includes(marker.user_id));
      }
      return [];
    },
  };
  return db;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

const markRead = (baseUrl, token, sessionId, body) => fetch(`${baseUrl}/backend/sessions/${sessionId}/read`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

const readState = (baseUrl, token, sessionId) => fetch(`${baseUrl}/backend/sessions/${sessionId}/read-state`, {
  headers: { Authorization: `Bearer ${token}` },
});

const upserts = db => db.sql.filter(entry => entry.q.startsWith('insert into session_read_state'));

// ---------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------

test('the marker is stamped from the MESSAGE, and a client-supplied time is ignored', async () => {
  // The clock-skew fix. If the route ever accepts a timestamp, a browser running
  // fast marks messages read that arrived after the reader closed the tab —
  // and unlike a presence signal there is no TTL to absorb the error in.
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await markRead(baseUrl, token, CHANNEL, {
      lastSeenMessageId: MESSAGE,
      // Every spelling a well-meaning client might reach for. None may be bound.
      readAt: '2099-01-01T00:00:00.000Z',
      read_at: '2099-01-01T00:00:00.000Z',
      timestamp: 2145916800000,
    });
    assert.equal(res.status, 200);
  });

  const [upsert] = upserts(db);
  assert.deepEqual(upsert.params.map(String), [CHANNEL, OWNER, MESSAGE], 'three params: session, user, message');
  assert.ok(
    !upsert.params.some(param => String(param).includes('2099')),
    'no client timestamp reaches the statement',
  );
  assert.match(upsert.sql, /select \$1::uuid, \$2::uuid, m\.created_at/, 'the time comes from the message row');
});

test('the statement resolves the time from messages and pins the message to the session', () => {
  // Both are properties of the SQL, so they are asserted against the SQL. The
  // session pin is not redundant with the route's own gate: without it a caller
  // could name a message from a DIFFERENT conversation to plant a marker at an
  // arbitrary point in time — including one far in the future, which would mark
  // everything in this session as read.
  assert.match(ADVANCE_READ_MARKER_SQL, /from messages m/);
  assert.match(ADVANCE_READ_MARKER_SQL, /where m\.id = \$3::uuid\s+and m\.session_id = \$1::uuid/);
});

test('a message from another session cannot plant a marker', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await markRead(baseUrl, token, CHANNEL, { lastSeenMessageId: OTHER_SESSION_MESSAGE });
    // Reported as success — "your marker is already at or ahead of this" and
    // "that message is not in this conversation" are both nothing-happened, and
    // distinguishing them for the caller would leak that the message exists.
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.marker, null);
  });
  assert.deepEqual(db.written, [], 'nothing was stored');
});

// ---------------------------------------------------------------------------
// Monotonicity
// ---------------------------------------------------------------------------

test('the marker can only ever move FORWARD', () => {
  // The guard is one line of SQL and no mock can prove it: a fake that applied
  // the comparison itself would be testing the fake. So it is asserted where it
  // lives. Dropping the `where` turns an out-of-order write from a second device
  // into an un-read, which is the failure inbox_read_state was built to avoid.
  assert.match(
    ADVANCE_READ_MARKER_SQL,
    /on conflict \(session_id, user_id\)\s+do update set read_at = excluded\.read_at, updated_at = now\(\)\s+where session_read_state\.read_at < excluded\.read_at/,
  );
});

// ---------------------------------------------------------------------------
// The opt-out, both directions
// ---------------------------------------------------------------------------

test("an opted-out reader's marker is never STORED", async () => {
  // Not filtered on the way out — never written. There is then nothing left
  // behind to leak later, and no migration if the policy changes. The check is
  // in the statement's WHERE rather than in the route body so the second backend
  // cannot forget it.
  const db = makeDb({ optedOut: [OWNER] });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await markRead(baseUrl, token, CHANNEL, { lastSeenMessageId: MESSAGE });
    // Still 200: a caller must not be able to detect a setting by probing, and
    // their own client already knows their own.
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.marker, null);
  });
  assert.deepEqual(db.written, []);
  assert.match(
    ADVANCE_READ_MARKER_SQL,
    /join app_users u on u\.id = \$2::uuid[\s\S]*coalesce\(u\.share_read_receipts, true\)/,
    'the opt-out is a predicate on the write, not a branch in one route',
  );
});

test('an opted-out reader is omitted from what everyone else sees', async () => {
  const db = makeDb({
    roles: { [MEMBER]: 'editor' },
    optedOut: [MEMBER],
    markers: [
      { session_id: CHANNEL, user_id: OWNER, read_at: '2026-07-01T00:00:00.000Z' },
      { session_id: CHANNEL, user_id: MEMBER, read_at: '2026-07-01T00:00:00.000Z' },
    ],
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await readState(baseUrl, token, CHANNEL);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.deepEqual(data.markers.map(marker => marker.user_id), [OWNER]);
  });
  assert.match(SESSION_READ_STATE_SQL, /join app_users u on u\.id = r\.user_id/);
});

test('the opt-out is RECIPROCAL — switching it off also stops you seeing others', async () => {
  // What keeps the setting from being a one-way mirror: the cost of hiding is
  // symmetric. Enforced in the statement, not by the UI declining to draw what
  // it was sent.
  const db = makeDb({
    roles: { [MEMBER]: 'editor' },
    optedOut: [MEMBER],
    markers: [{ session_id: CHANNEL, user_id: OWNER, read_at: '2026-07-01T00:00:00.000Z' }],
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(MEMBER, '1');

  await withServer(async (baseUrl) => {
    const res = await readState(baseUrl, token, CHANNEL);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.markers, []);
  });
  assert.match(
    SESSION_READ_STATE_SQL,
    /exists \(\s*select 1 from app_users me\s+where me\.id = \$2::uuid and coalesce\(me\.share_read_receipts, true\)\s*\)/,
  );
});

test('updated_at is never projected', () => {
  // It records when a marker last MOVED — a second, finer clock than "read up to
  // this point", and not a disclosure this feature makes.
  assert.doesNotMatch(SESSION_READ_STATE_SQL, /updated_at/);
  assert.deepEqual(SELECTABLE_COLUMNS_BY_TABLE.session_read_state, ['session_id', 'user_id', 'read_at']);
});

// ---------------------------------------------------------------------------
// Privacy: DMs
// ---------------------------------------------------------------------------

test('a workspace member who is not in a DM cannot read its receipts', async () => {
  const db = makeDb({ roles: { [OUTSIDER]: 'editor' }, dmMembers: [OWNER] });
  __test.setTestDb(db);
  const token = await __test.issueToken(OUTSIDER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await readState(baseUrl, token, DM)).status, 403);
    assert.equal((await markRead(baseUrl, token, DM, { lastSeenMessageId: MESSAGE })).status, 403);
  });
  assert.deepEqual(db.written, [], 'a refused caller writes nothing');
});

test('a member OF the DM can both mark and read its receipts', async () => {
  // The allow direction. Without it every test above passes against a build that
  // refuses everyone.
  const db = makeDb({
    roles: { [OUTSIDER]: 'editor' },
    dmMembers: [OUTSIDER],
    markers: [{ session_id: DM, user_id: OWNER, read_at: '2026-07-01T00:00:00.000Z' }],
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(OUTSIDER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await markRead(baseUrl, token, DM, { lastSeenMessageId: MESSAGE })).status, 200);
    const res = await readState(baseUrl, token, DM);
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()).data.markers.map(m => m.user_id), [OWNER]);
  });
  assert.deepEqual(db.written, [{ sessionId: DM, userId: OUTSIDER, messageId: MESSAGE }]);
});

test('a non-member of the WORKSPACE is refused before anything else', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OUTSIDER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await readState(baseUrl, token, CHANNEL)).status, 403);
  });
});

test('an unauthenticated caller gets 401 and writes nothing', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/sessions/${CHANNEL}/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lastSeenMessageId: MESSAGE }),
    });
    assert.equal(res.status, 401);
    assert.equal((await fetch(`${baseUrl}/backend/sessions/${CHANNEL}/read-state`)).status, 401);
  });
  assert.deepEqual(db.written, []);
});

test('a missing lastSeenMessageId is a 400, not a marker at "now"', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await markRead(baseUrl, token, CHANNEL, {})).status, 400);
  });
  assert.deepEqual(db.written, [], 'defaulting to now() would be a receipt for messages nobody saw');
});

// ---------------------------------------------------------------------------
// The generic /db path
// ---------------------------------------------------------------------------

test('the table is allowlisted AND workspace-scoped — the pair, not either half', () => {
  // A table in ALLOWED_TABLES but missing from WORKSPACE_SCOPED_TABLES gets NO
  // row scoping at all: enforceDbOperationAccess returns EARLY for a table it
  // does not find there. For this table that would be every tenant's
  // who-read-what readable by any signed-in user. The Set membership is also
  // what makes the session gate reachable, since that gate lives below the same
  // early return.
  assert.ok(ALLOWED_TABLES.has('session_read_state'), 'otherwise the subscription is refused, silently');
  assert.ok(WORKSPACE_SCOPED_TABLES.has('session_read_state'), 'otherwise there is no row scoping AT ALL');
});

test('every generic WRITE is gated to manage, so the dedicated route is the only writer', () => {
  assert.deepEqual(DB_TABLE_ACCESS.session_read_state, {
    select: 'read', insert: 'manage', update: 'manage', delete: 'manage',
  });
});

test('a generic insert into session_read_state is refused, even for an owner', async () => {
  // The behavioural half of the entry above, and it is refused TWICE OVER.
  //
  // The 'manage' gate is the declared rule. Underneath it the insert is refused
  // for a structural reason as well: resolveOperationWorkspace derives a tenant
  // for an INSERT from `values.workspace_id` (or, for `messages` alone, from a
  // session), and this table has neither — so a forged row cannot resolve a
  // workspace and is rejected before capability is even considered.
  //
  // OWNER is used deliberately: they hold 'manage', so a test that only refused
  // an editor would pass against a build where the highest role could forge a
  // claim that somebody else read something at a time of the forger's choosing.
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/db/insert`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'session_read_state',
        values: { session_id: CHANNEL, user_id: MEMBER, read_at: '2099-01-01T00:00:00.000Z' },
      }),
    });
    assert.equal(res.status, 400, 'a workspace reference is required, and this table cannot carry one');
  });
  assert.deepEqual(db.written, []);
  assert.deepEqual(
    db.sql.filter(entry => entry.q.startsWith('insert into session_read_state')),
    [],
    'and no insert ever reached the database',
  );
});

test('a select filtered by a session the caller cannot read is refused', async () => {
  // This is also the REALTIME gate: authorizeRealtimeBinding authorizes a
  // db_changes binding by calling enforceDbOperationAccess with op 'select', so
  // the same refusal stops a non-member SUBSCRIBING to a DM's read state.
  const db = makeDb({ roles: { [OUTSIDER]: 'editor' }, dmMembers: [OWNER] });
  __test.setTestDb(db);
  const token = await __test.issueToken(OUTSIDER, '1');

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/db/select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'session_read_state',
        filters: [{ column: 'session_id', operator: 'eq', value: DM }],
      }),
    });
    assert.equal(res.status, 403);
  });
});

test('an UNFILTERED select cannot be expressed, because the table has no workspace column', async () => {
  // The structural half of the privacy story. With no workspace_id column there
  // is nothing for a client to filter on that resolves a tenant, so the only
  // subscription that authorizes is one that names a session — and naming a
  // private session requires membership (the test above). That is why receipts
  // do NOT need an entry beside chat_sessions in the private-fanout split.
  const db = makeDb({ roles: { [MEMBER]: 'editor' } });
  __test.setTestDb(db);
  const token = await __test.issueToken(MEMBER, '1');

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/db/select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ table: 'session_read_state', filters: [] }),
    });
    assert.equal(res.status, 400, 'a workspace filter is required, and there is no column to give one');
  });
});
