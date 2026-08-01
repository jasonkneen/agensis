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
const fs = require('node:fs');
const path = require('node:path');
const { createApp, __test } = require('../server/index.cjs');
const {
  ADVANCE_READ_MARKER_SQL,
  ADVANCE_AGENT_READ_MARKER_SQL,
  DELETE_HUMAN_READ_MARKERS_SQL,
  SESSION_READ_STATE_SQL,
  SESSION_READ_STATE_DDL,
  SESSION_READ_STATE_UPGRADE_STEPS,
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
const THREAD_ROOT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const THREAD_REPLY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

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
      if (q.startsWith('select id from app_users where id = any')) {
        const ids = String(params[0]).match(/"([^"]+)"/g)?.map(value => value.slice(1, -1)) || [];
        return ids.filter(id => !optedOut.includes(id)).map(id => ({ id }));
      }
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
      if (q.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')
        || q.startsWith('select id, visibility, folder, deleted_at from chat_sessions')) {
        if (String(params[0]) === CHANNEL) {
          return [{ id: CHANNEL, workspace_id: WORKSPACE, visibility: 'workspace', folder: 'General', deleted_at: null }];
        }
        if (String(params[0]) === DM) {
          return [{ id: DM, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages', deleted_at: null }];
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
      if (q.includes('insert into session_read_state')
        && q.includes('session_id, user_id, thread_parent_id, last_seen_message_id, read_at')) {
        const [rawSessionId, rawUserId, rawMessageId, rawThreadParentId] = params;
        const sessionId = String(rawSessionId);
        const userId = String(rawUserId);
        const messageId = String(rawMessageId);
        const threadParentId = rawThreadParentId == null ? null : String(rawThreadParentId);
        if (optedOut.includes(userId)) return [];
        const messageThread = messageId === MESSAGE ? null
          : messageId === THREAD_ROOT ? THREAD_ROOT
            : messageId === THREAD_REPLY ? THREAD_ROOT
              : undefined;
        if (messageThread === undefined) return [];     // `m.id = $3`
        if (sessionId !== CHANNEL && sessionId !== DM) return [];
        if (threadParentId === null && messageThread !== null) return [];
        if (threadParentId !== null && messageId !== threadParentId && messageThread !== threadParentId) return [];
        written.push({ sessionId, userId, messageId, threadParentId });
        return [{
          marker_id: `marker-${sessionId}-${userId}-${threadParentId || 'channel'}`,
          event_version: String(written.length),
          session_id: sessionId,
          user_id: userId,
          agent_id: null,
          thread_parent_id: threadParentId,
          last_seen_message_id: messageId,
          read_at: '2026-07-01T00:00:00.000Z',
        }];
      }

      // The read projects a unified reader_id/reader_kind across human + agent
      // markers. The mock stores markers keyed by user_id (its fixtures predate
      // agents) and returns them in the route's projected shape.
      if (q.includes('from session_read_state r')) {
        const [rawSessionId, rawCallerId, rawThreadParentId] = params;
        const sessionId = String(rawSessionId);
        const callerId = String(rawCallerId);
        const threadParentId = rawThreadParentId == null ? null : String(rawThreadParentId);
        // Reciprocity and the omission of opted-out readers are BOTH in the
        // statement's WHERE; the mock applies the caller's own flag and each
        // row's flag exactly as those predicates would.
        if (optedOut.includes(callerId)) return [];
        return markers
          .filter(marker => marker.session_id === sessionId)
          .filter(marker => (marker.thread_parent_id ?? null) === threadParentId)
          .filter(marker => marker.agent_id != null || !optedOut.includes(marker.user_id))
          .map((marker, index) => ({
            marker_id: marker.marker_id || `fixture-marker-${index}`,
            event_version: String(marker.event_version || index + 1),
            session_id: marker.session_id,
            reader_id: marker.user_id ?? marker.agent_id,
            reader_kind: marker.agent_id != null ? 'agent' : 'human',
            thread_parent_id: marker.thread_parent_id ?? null,
            last_seen_message_id: marker.last_seen_message_id || MESSAGE,
            read_at: marker.read_at,
          }));
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

const readState = (baseUrl, token, sessionId, threadParentId = null) => {
  const url = new URL(`${baseUrl}/backend/sessions/${sessionId}/read-state`);
  if (threadParentId) url.searchParams.set('thread_parent_id', threadParentId);
  return fetch(url, { headers: { Authorization: `Bearer ${token}` } });
};

const upserts = db => db.sql.filter(entry =>
  entry.q.includes('insert into session_read_state')
  && entry.q.includes('session_id, user_id, thread_parent_id, last_seen_message_id, read_at'));

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
  assert.deepEqual(
    upsert.params,
    [CHANNEL, OWNER, MESSAGE, null],
    'four params: session, user, exact message, and channel/thread scope',
  );
  assert.ok(
    !upsert.params.some(param => String(param).includes('2099')),
    'no client timestamp reaches the statement',
  );
  assert.match(
    upsert.sql,
    /select \$1::uuid, \$2::uuid, \$4::uuid, marker\.id, marker\.created_at/,
    'the message identity and time both come from the visible message row',
  );
});

test('channel and thread markers are separate scopes, and the fourth bind carries the thread root', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await markRead(baseUrl, token, CHANNEL, {
      lastSeenMessageId: MESSAGE,
    })).status, 200);
    assert.equal((await markRead(baseUrl, token, CHANNEL, {
      lastSeenMessageId: THREAD_REPLY,
      threadParentId: THREAD_ROOT,
    })).status, 200);
  });

  assert.deepEqual(db.written, [
    { sessionId: CHANNEL, userId: OWNER, messageId: MESSAGE, threadParentId: null },
    { sessionId: CHANNEL, userId: OWNER, messageId: THREAD_REPLY, threadParentId: THREAD_ROOT },
  ]);
});

test('the statement resolves the time from messages and pins the message to the session', () => {
  // Both are properties of the SQL, so they are asserted against the SQL. The
  // session pin is not redundant with the route's own gate: without it a caller
  // could name a message from a DIFFERENT conversation to plant a marker at an
  // arbitrary point in time — including one far in the future, which would mark
  // everything in this session as read.
  assert.match(ADVANCE_READ_MARKER_SQL, /from messages m/);
  assert.match(ADVANCE_READ_MARKER_SQL, /where m\.id = \$3::uuid\s+and m\.deleted_at is null/);
  assert.match(ADVANCE_READ_MARKER_SQL, /read_marker_session\.id = \$1::uuid/);
  assert.match(ADVANCE_READ_MARKER_SQL, /join readable_marker_session readable on readable\.id = m\.session_id/);
  assert.match(ADVANCE_READ_MARKER_SQL, /chat_session_members[\s\S]*for share/);
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
    /on conflict \(session_id, user_id, thread_parent_id\) where user_id is not null[\s\S]*where \(session_read_state\.read_at, session_read_state\.last_seen_message_id\)\s*< \(excluded\.read_at, excluded\.last_seen_message_id\)/,
  );
});

test('equal-time messages advance deterministically by the message-id tuple', () => {
  // Postgres timestamps need not be unique. Comparing read_at alone would drop a
  // later marker when two messages share the same timestamp, so both reader lanes
  // use the message id as the deterministic second tuple element.
  for (const sql of [ADVANCE_READ_MARKER_SQL, ADVANCE_AGENT_READ_MARKER_SQL]) {
    assert.match(
      sql,
      /where \(session_read_state\.read_at, session_read_state\.last_seen_message_id\)\s*< \(excluded\.read_at, excluded\.last_seen_message_id\)/,
    );
    assert.match(sql, /last_seen_message_id = excluded\.last_seen_message_id/);
  }
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
    /receipt_sharing_user[\s\S]*coalesce\(sharing_user\.share_read_receipts, true\)[\s\S]*for share of sharing_user/,
    'the opt-out is a locked predicate on the write, not a branch in one route',
  );
});

test('disabling receipts deletes human markers but preserves agent markers', () => {
  assert.match(DELETE_HUMAN_READ_MARKERS_SQL, /where user_id = \$1::uuid/);
  assert.match(DELETE_HUMAN_READ_MARKERS_SQL, /agent_id is null/);
  assert.match(
    DELETE_HUMAN_READ_MARKERS_SQL,
    /returning marker_id, event_version, session_id, user_id, agent_id, thread_parent_id,\s+last_seen_message_id, read_at/,
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
    assert.deepEqual(data.markers.map(marker => marker.reader_id), [OWNER]);
  });
  assert.match(SESSION_READ_STATE_SQL, /left join app_users u on u\.id = r\.user_id/);
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
  assert.deepEqual(SELECTABLE_COLUMNS_BY_TABLE.session_read_state, [
    'marker_id', 'event_version', 'session_id', 'user_id', 'agent_id',
    'thread_parent_id', 'last_seen_message_id', 'read_at',
  ]);
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
    assert.deepEqual((await res.json()).data.markers.map(m => m.reader_id), [OWNER]);
  });
  assert.deepEqual(db.written, [{
    sessionId: DM, userId: OUTSIDER, messageId: MESSAGE, threadParentId: null,
  }]);
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
// Agents as readers
// ---------------------------------------------------------------------------

test('an agent marker is keyed by agent_id, not user_id, and skips the human opt-out', () => {
  // An agent is not in app_users, so its write must NOT join that table — there is
  // no share_read_receipts row to honour, and joining would drop every agent
  // marker. The conflict target is the agent partial index, mirroring the human
  // path's forward-only guard.
  assert.match(
    ADVANCE_AGENT_READ_MARKER_SQL,
    /insert into session_read_state \(\s*session_id, agent_id, thread_parent_id, last_seen_message_id, read_at\s*\)/,
  );
  assert.doesNotMatch(ADVANCE_AGENT_READ_MARKER_SQL, /app_users/);
  assert.match(
    ADVANCE_AGENT_READ_MARKER_SQL,
    /on conflict \(session_id, agent_id, thread_parent_id\) where agent_id is not null[\s\S]*where \(session_read_state\.read_at, session_read_state\.last_seen_message_id\)\s*< \(excluded\.read_at, excluded\.last_seen_message_id\)/,
  );
});

test("an agent's marker resolves the exact delivered message and never scans for latest", () => {
  // The server captures this id with the bounded context/claimed prompt. Looking
  // up "latest" here would include messages arriving during a long run or rows
  // outside a thread-scoped prompt.
  assert.match(ADVANCE_AGENT_READ_MARKER_SQL, /from messages m\s+join readable_agent_session readable on readable\.id = m\.session_id/);
  assert.match(ADVANCE_AGENT_READ_MARKER_SQL, /marker_agent\.enabled is not false/);
  assert.doesNotMatch(
    ADVANCE_AGENT_READ_MARKER_SQL,
    /marker_agent\.mcp_approved/,
    'MCP approval is unrelated to a builtin turn that already read its own session',
  );
  assert.match(ADVANCE_AGENT_READ_MARKER_SQL, /jsonb_array_elements/);
  assert.match(ADVANCE_AGENT_READ_MARKER_SQL, /m\.id = \$3::uuid/);
  assert.match(ADVANCE_AGENT_READ_MARKER_SQL, /coalesce\(m\.sender_kind, ''\) = 'agent'/);
  assert.doesNotMatch(ADVANCE_AGENT_READ_MARKER_SQL, /order by m\.created_at desc/);
});

test('the read projection unifies human and agent markers into reader_id + reader_kind', () => {
  // The client resolves a name the same way for both, so the two reader columns
  // collapse to one opaque id. The left join (not join) is what lets an agent row,
  // which has no app_users match, survive the read.
  assert.match(SESSION_READ_STATE_SQL, /coalesce\(r\.user_id, r\.agent_id\) as reader_id/);
  assert.match(SESSION_READ_STATE_SQL, /when r\.agent_id is not null then 'agent' else 'human' end as reader_kind/);
  assert.match(SESSION_READ_STATE_SQL, /r\.agent_id is not null or coalesce\(u\.share_read_receipts, true\)/);
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

test('every generic WRITE keeps a manage fallback beneath the explicit dedicated-route refusal', () => {
  assert.deepEqual(DB_TABLE_ACCESS.session_read_state, {
    select: 'read', insert: 'manage', update: 'manage', delete: 'manage',
  });
});

test('generic receipt insert, update, and delete are refused even for an owner', async () => {
  // OWNER is deliberate: the shared refusal is a server-authority boundary,
  // not merely an RBAC threshold. INSERT/UPDATE could fabricate who read what
  // and when; DELETE could erase a real social signal.
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const attempts = [
      {
        route: 'insert',
        body: {
          table: 'session_read_state',
          values: { session_id: CHANNEL, user_id: MEMBER, read_at: '2099-01-01T00:00:00.000Z' },
        },
      },
      {
        route: 'update',
        body: {
          table: 'session_read_state',
          values: { read_at: '2099-01-01T00:00:00.000Z' },
          filters: [{ column: 'session_id', operator: 'eq', value: CHANNEL }],
        },
      },
      {
        route: 'delete',
        body: {
          table: 'session_read_state',
          filters: [{ column: 'session_id', operator: 'eq', value: CHANNEL }],
        },
      },
    ];

    for (const attempt of attempts) {
      const res = await fetch(`${baseUrl}/backend/db/${attempt.route}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(attempt.body),
      });
      assert.equal(res.status, 403, `${attempt.route} must be unreachable to an owner`);
      assert.match((await res.json()).error.message, /dedicated read receipt route/i);
    }
  });
  assert.deepEqual(db.written, []);
  const bootstrapStatements = new Set(SESSION_READ_STATE_UPGRADE_STEPS.map(statement =>
    String(statement).replace(/\s+/g, ' ').trim().toLowerCase()));
  assert.deepEqual(
    db.sql.filter(entry =>
      /^(insert into|update|delete from) session_read_state/i.test(entry.q)
      && !bootstrapStatements.has(entry.q)),
    [],
    'no generic receipt mutation reaches Postgres',
  );
});

test('the generic select cannot bypass the dedicated reciprocal projection', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/db/select`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'session_read_state',
        filters: [{ column: 'session_id', operator: 'eq', value: CHANNEL }],
      }),
    });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error.message, /dedicated route/i);
  });
  assert.equal(
    db.sql.some(entry => /^select .* from session_read_state/i.test(entry.q)),
    false,
    'no raw marker query reaches Postgres',
  );
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
    assert.equal(res.status, 403, 'the dedicated route is the only snapshot read surface');
  });
});

test('the upgrade steps drop the primary key BEFORE dropping user_id NOT NULL', () => {
  // Regression guard for a live-only failure the mock DB cannot surface: on a
  // table that still carries the original PRIMARY KEY (session_id, user_id),
  // Postgres refuses `ALTER COLUMN user_id DROP NOT NULL` while the column is
  // still part of a primary key ("column ... is in a primary key"). The fresh
  // CREATE TABLE has no PK, so a mock/fresh boot never hits it — only a real
  // in-place upgrade does. The steps are also applied ONE db.unsafe() at a time
  // (the extended protocol rejects a multi-statement string), so ordering is a
  // property of the step LIST, not of one string.
  const steps = SESSION_READ_STATE_UPGRADE_STEPS;
  const dropPk = steps.findIndex(s => s.includes('DROP CONSTRAINT IF EXISTS session_read_state_pkey'));
  const dropNotNull = steps.findIndex(s => s.includes('ALTER COLUMN user_id DROP NOT NULL'));
  assert.ok(dropPk >= 0, 'a step must drop the legacy primary key');
  assert.ok(dropNotNull >= 0, 'a step must make user_id nullable');
  assert.ok(dropPk < dropNotNull, 'DROP CONSTRAINT pkey must come before DROP NOT NULL');
  // And the CREATE itself must be a single statement — no ALTER smuggled in, or
  // ensureRuntimeSchema's single db.unsafe() would throw on the extended protocol.
  assert.ok(!/;\s*\S/.test(SESSION_READ_STATE_DDL.trim().replace(/;\s*$/, '')), 'the CREATE DDL is one statement');
});

test('the agent-receipt migration does not apply a session-wide index to thread-scoped data', () => {
  // A Fly boot can already have installed the later thread-scoped shape before
  // the migration ledger catches up. In that state, duplicate (session, agent)
  // rows are valid across different thread roots; the transitional index from
  // this migration must be skipped so the scope migration can install the right
  // constraint instead.
  const migration = fs.readFileSync(
    path.resolve(__dirname, '../supabase/migrations/20260731130000_agent_read_receipts.sql'),
    'utf8',
  );
  assert.match(migration, /information_schema\.columns[\s\S]*column_name\s*=\s*'thread_parent_id'/i);
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_agent_uidx/i);
  assert.match(migration, /IF NOT EXISTS \([\s\S]*thread_parent_id[\s\S]*\) THEN[\s\S]*session_read_state_agent_uidx/i);
});

test('the opt-out reverse lookup has the same partial user index in all three schema authorities', () => {
  const lookupIndex =
    /create index if not exists session_read_state_user_lookup_idx\s+on session_read_state\s*\(user_id\)\s+where user_id is not null/i;
  const runtime = SESSION_READ_STATE_UPGRADE_STEPS.join('\n');
  const canonical = fs.readFileSync(
    path.resolve(__dirname, '../database/neon-schema.sql'),
    'utf8',
  );
  const migration = fs.readFileSync(
    path.resolve(
      __dirname,
      '../supabase/migrations/20260731180000_session_read_state_user_lookup.sql',
    ),
    'utf8',
  );

  assert.match(DELETE_HUMAN_READ_MARKERS_SQL, /where user_id = \$1::uuid/);
  for (const [label, source] of [
    ['runtime bootstrap', runtime],
    ['canonical schema', canonical],
    ['migration', migration],
  ]) {
    assert.match(source, lookupIndex, `${label} is missing the opt-out lookup index`);
  }
});
