'use strict';

// ============================================================================
// tests/dm-read-scope.test.cjs
// ----------------------------------------------------------------------------
// The "…and allow it when required" half of DM privacy, plus the two places the
// rule is expressed as SQL rather than as a function call.
//
// tests/dm-scope-assumption.test.cjs covers the GATE (who is refused). This file
// covers the parts that gate cannot reach:
//
//   1. the grant/revoke routes — who may hand out access, and to whom
//   2. the SQL predicate builders, which no row-at-a-time check ever executes
//   3. that a grant-holder cannot become a grant-GIVER (the escalation)
//
// THE ASSERTIONS THAT MATTER MOST are the negative ones. A test suite that only
// proves "manage can grant" would pass against a build where EVERYONE can grant.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');
const core = require('../shared/backend-core.cjs');

const OWNER = 'owner-1';
const EDITOR = 'editor-1';       // has write/run_agents, NOT manage
const GRANTEE = 'grantee-1';
const OUTSIDER = 'outsider-1';   // not in the workspace at all
const WORKSPACE = 'w1';
const DM = 'dm-1';
const CHANNEL = 'chan-1';

test.afterEach(() => __test.resetTestState());

function makeDb({ members = [], roles = {} } = {}) {
 const writes = { audits: [], memberInserts: [], memberDeletes: [] };
 // Stored as objects so `source` is real data the route has to read, not
 // something the mock decides.
 let memberRows = members.map((m) => ({ ...m }));
 const db = {
  writes,
  get memberRows() { return memberRows; },
  async unsafe(sql, params = []) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   const q = n.toLowerCase();
   if (q.startsWith('select value from app_settings')) {
    return params[0] === 'AUTH_SECRET' ? [{ value: 'dm-scope-secret' }] : [];
   }
   if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
   // ORDER MATTERS: the "is the grantee in this workspace" probe also starts
   // `select 1 from workspaces where id = $1 and user_id = $2`, so it must be
   // matched BEFORE the ownership check or every grant 400s.
   if (q.includes('union all') && q.includes('workspace_members where workspace_id = $1 and user_id = $2')) {
    const uid = String(params[1]);
    return (uid === OWNER || roles[uid]) ? [{ ok: 1 }] : [];
   }
   if (q.startsWith('select 1 from workspaces where id') && q.includes('user_id = $2')) {
    return String(params[1]) === OWNER ? [{ ok: 1 }] : [];
   }
   if (q.startsWith('select role from workspace_members')) {
    const role = roles[String(params[1])];
    return role ? [{ role }] : [];
   }
   if (q.includes('with recursive chain as')) return [];
   // The route's session load.
   if (q.startsWith('select id, workspace_id, title, folder, visibility from chat_sessions')) {
    if (params[0] === DM) {
     return [{ id: DM, workspace_id: WORKSPACE, title: 'Coder', folder: 'Direct messages', visibility: 'private' }];
    }
    if (params[0] === CHANNEL) {
     return [{ id: CHANNEL, workspace_id: WORKSPACE, title: 'General', folder: 'General', visibility: 'workspace' }];
    }
    return [];
   }
   if (q.startsWith('insert into chat_session_members')) {
    // TWO different writers reach this table and they must not be conflated.
    // The GRANT ROUTE binds four params and names 'grant' inline; the boot-time
    // migration (server/dm-scope-backfill.cjs) issues parameterless seeding
    // INSERTs, and ensureRuntimeSchema runs in this harness. Counting both made
    // "exactly one grant was written" read 4.
    if (q.includes("values ($1, $2, 'grant'")) writes.memberInserts.push({ sql: n, params });
    else return [];
    const [sessionId, userId, grantedBy, expiresAt] = params;
    const existing = memberRows.find((r) => r.session_id === sessionId && r.user_id === userId);
    if (existing) {
     // Mirrors `do update ... where source = 'grant'`: a participant row is
     // left alone AND returns nothing.
     if (existing.source !== 'grant') return [];
     existing.granted_by = grantedBy;
     existing.expires_at = expiresAt;
     return [{ user_id: userId, source: 'grant', expires_at: expiresAt }];
    }
    memberRows.push({ session_id: sessionId, user_id: userId, source: 'grant', granted_by: grantedBy, expires_at: expiresAt });
    return [{ user_id: userId, source: 'grant', expires_at: expiresAt }];
   }
   if (q.startsWith('delete from chat_session_members')) {
    writes.memberDeletes.push({ sql: n, params });
    const [sessionId, userId] = params;
    const before = memberRows.length;
    // The route's own SQL says `and source = 'grant'`; the mock honours the
    // parameters it was given rather than re-deciding the rule.
    const onlyGrants = q.includes("source = 'grant'");
    memberRows = memberRows.filter((r) => !(
     r.session_id === sessionId && r.user_id === userId && (!onlyGrants || r.source === 'grant')
    ));
    return before === memberRows.length ? [] : [{ user_id: userId }];
   }
   if (q.startsWith('select m.user_id, m.source')) {
    return memberRows
     .filter((r) => r.session_id === params[0])
     .map((r) => ({ ...r, name: '' }));
   }
   if (q.startsWith('insert into audit_log')) {
    writes.audits.push({ sql: n, params });
    return [{ id: `a-${writes.audits.length}` }];
   }
   return [];
  },
 };
 return db;
}

async function withServer(fn) {
 const app = createApp();
 const server = http.createServer(app);
 await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
 const { port } = server.address();
 try {
  return await fn(`http://127.0.0.1:${port}`);
 } finally {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
 }
}

const grant = (baseUrl, token, sessionId, body) => fetch(`${baseUrl}/backend/sessions/${sessionId}/access`, {
 method: 'POST',
 headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
 body: JSON.stringify(body),
});

const revoke = (baseUrl, token, sessionId, userId) => fetch(`${baseUrl}/backend/sessions/${sessionId}/access/${userId}`, {
 method: 'DELETE',
 headers: { Authorization: `Bearer ${token}` },
});

// ---------------------------------------------------------------------------
// Who may grant
// ---------------------------------------------------------------------------

test('a manage holder can grant read access to a DM, and it is audited', async () => {
 const db = makeDb({ members: [{ session_id: DM, user_id: OWNER, source: 'participant' }], roles: { [GRANTEE]: 'viewer' } });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');

 await withServer(async (baseUrl) => {
  const res = await grant(baseUrl, token, DM, { userId: GRANTEE });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.data.source, 'grant');
 });

 assert.equal(db.writes.memberInserts.length, 1);
 const audit = db.writes.audits.find((a) => a.params.includes('chat_session.access_granted'));
 assert.ok(audit, 'a grant must leave an audit row — a silent grant looks like privacy without being it');
});

test('an EDITOR cannot grant, even though they can write and run agents', async () => {
 // The escalation this route exists to refuse. `editor` carries write, comment
 // and run_agents; the one thing it must not carry is handing out reads of
 // other people's conversations.
 const db = makeDb({ members: [{ session_id: DM, user_id: OWNER, source: 'participant' }], roles: { [EDITOR]: 'editor', [GRANTEE]: 'viewer' } });
 __test.setTestDb(db);
 const token = await __test.issueToken(EDITOR, '1');

 await withServer(async (baseUrl) => {
  const res = await grant(baseUrl, token, DM, { userId: GRANTEE });
  assert.equal(res.status, 403);
 });
 assert.equal(db.writes.memberInserts.length, 0, 'nothing may be written on a refused grant');
});

test('holding a GRANT does not let you grant it onward', async () => {
 // THE COMPOUNDING FAILURE. If authorization were "you may grant what you can
 // read", one grant would seed the next and a single share would spread to the
 // whole workspace. The grantee here can read the DM and still gets 403.
 const db = makeDb({
  members: [
   { session_id: DM, user_id: OWNER, source: 'participant' },
   { session_id: DM, user_id: GRANTEE, source: 'grant', granted_by: OWNER },
  ],
  roles: { [GRANTEE]: 'viewer', [OUTSIDER]: 'viewer' },
 });
 __test.setTestDb(db);
 const token = await __test.issueToken(GRANTEE, '1');

 await withServer(async (baseUrl) => {
  const res = await grant(baseUrl, token, DM, { userId: OUTSIDER });
  assert.equal(res.status, 403);
 });
 assert.equal(db.writes.memberInserts.length, 0);
});

test('a grant cannot be handed to someone outside the workspace', async () => {
 // A grant widens what a MEMBER sees; it is not a way into the tenant.
 const db = makeDb({ members: [{ session_id: DM, user_id: OWNER, source: 'participant' }], roles: {} });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');

 await withServer(async (baseUrl) => {
  const res = await grant(baseUrl, token, DM, { userId: OUTSIDER });
  assert.equal(res.status, 400);
 });
 assert.equal(db.writes.memberInserts.length, 0);
});

test('granting on a non-private session is refused as meaningless', async () => {
 const db = makeDb({ members: [], roles: { [GRANTEE]: 'viewer' } });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');
 await withServer(async (baseUrl) => {
  const res = await grant(baseUrl, token, CHANNEL, { userId: GRANTEE });
  assert.equal(res.status, 400);
 });
});

test('expiresInDays is bounded', async () => {
 const db = makeDb({ members: [{ session_id: DM, user_id: OWNER, source: 'participant' }], roles: { [GRANTEE]: 'viewer' } });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');
 await withServer(async (baseUrl) => {
  assert.equal((await grant(baseUrl, token, DM, { userId: GRANTEE, expiresInDays: 0 })).status, 400);
  assert.equal((await grant(baseUrl, token, DM, { userId: GRANTEE, expiresInDays: 400 })).status, 400);
  const ok = await grant(baseUrl, token, DM, { userId: GRANTEE, expiresInDays: 7 });
  assert.equal(ok.status, 200);
  assert.ok((await ok.json()).data.expiresAt, 'a bounded grant carries its expiry');
 });
});

// ---------------------------------------------------------------------------
// Revoke
// ---------------------------------------------------------------------------

test('revoke removes a grant', async () => {
 const db = makeDb({
  members: [
   { session_id: DM, user_id: OWNER, source: 'participant' },
   { session_id: DM, user_id: GRANTEE, source: 'grant', granted_by: OWNER },
  ],
  roles: { [GRANTEE]: 'viewer' },
 });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');
 await withServer(async (baseUrl) => {
  assert.equal((await revoke(baseUrl, token, DM, GRANTEE)).status, 200);
 });
 assert.ok(!db.memberRows.some((r) => r.user_id === GRANTEE), 'the grant is gone');
 assert.ok(db.writes.audits.some((a) => a.params.includes('chat_session.access_revoked')));
});

test('revoke can NEVER remove a participant — the person whose DM it is', async () => {
 // Rule 2. Without the `source = 'grant'` filter, "tidy up who can see this"
 // would lock the owner out of their own conversation, and the backfill's rows
 // are participants precisely so they are out of reach here.
 const db = makeDb({ members: [{ session_id: DM, user_id: OWNER, source: 'participant' }], roles: {} });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');
 await withServer(async (baseUrl) => {
  const res = await revoke(baseUrl, token, DM, OWNER);
  assert.equal(res.status, 404, 'there is no GRANT to revoke, and the participant row is untouchable');
 });
 assert.ok(db.memberRows.some((r) => r.user_id === OWNER && r.source === 'participant'), 'the participant survives');
 assert.ok(
  db.writes.memberDeletes.every((d) => d.sql.toLowerCase().includes("source = 'grant'")),
  'the DELETE must filter on source, not just on (session, user)',
 );
});

test('re-granting an existing PARTICIPANT does not demote them to a grant', async () => {
 // Otherwise a manage holder could convert the owner's own participation into
 // something revocable, and then revoke it.
 const db = makeDb({ members: [{ session_id: DM, user_id: OWNER, source: 'participant' }], roles: { [OWNER]: 'owner' } });
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');
 await withServer(async (baseUrl) => {
  const res = await grant(baseUrl, token, DM, { userId: OWNER });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.source, 'participant', 'still a participant, not downgraded');
 });
 assert.equal(
  db.memberRows.find((r) => r.user_id === OWNER).source, 'participant',
  'the stored row must keep source=participant',
 );
 // THE ASSERTION THAT ACTUALLY TESTS THE CODE. Everything above this line is
 // satisfied by the mock's own conflict handling, so on its own it measures the
 // mock — deleting the guard from the route left all of it green. The guard is
 // in the SQL, so the SQL is what has to be asserted. Mirrors the DELETE check
 // in the revoke test for the same reason.
 assert.ok(
  db.writes.memberInserts.every((i) => i.sql.toLowerCase().includes("where chat_session_members.source = 'grant'")),
  'the ON CONFLICT DO UPDATE must be filtered to grant rows, or a re-grant silently makes a participant revocable',
 );
});

// ---------------------------------------------------------------------------
// The SQL builders — no row-at-a-time check ever runs these
// ---------------------------------------------------------------------------

test('sessionReadableSql filters expiry and checks membership', () => {
 const sql = core.sessionReadableSql('s', '$2').replace(/\s+/g, ' ');
 assert.match(sql, /s\.deleted_at is null/, 'a deleted conversation is DB-only');
 assert.match(sql, /chat_session_members/, 'membership must be part of the predicate');
 assert.match(sql, /expires_at is null or csm\.expires_at > now\(\)/, 'expiry must be evaluated in SQL');
 assert.match(sql, /coalesce\(s\.visibility, 'workspace'\) <> 'private'/);
 assert.match(sql, /coalesce\(s\.folder, ''\) <> 'Direct messages'/, 'the folder backstop must survive');
});

test('sessionReadableSql refuses an injected alias or bind', () => {
 // The alias reaches the query as raw text. These throws are the reason that is
 // safe, so they are asserted rather than assumed.
 assert.throws(() => core.sessionReadableSql('s; drop table x', '$2'));
 assert.throws(() => core.sessionReadableSql('s', "$2; drop table x"));
 assert.throws(() => core.sessionReadableSql('s', '2'));
});

test('sessionReadableSql groups its OR correctly', () => {
 // (public AND not-a-DM) OR member — NOT public AND (not-a-DM OR member),
 // which would let any member of any session read every DM. Precedence makes
 // the unparenthesised version correct by luck; this asserts the parens exist.
 const sql = core.sessionReadableSql('s', '$2');
 const beforeOr = sql.slice(0, sql.indexOf(' or exists'));
 assert.equal(
  (beforeOr.match(/\(/g) || []).length - (beforeOr.match(/\)/g) || []).length, 2,
  'the two public conditions must be bracketed together as one OR operand',
 );
});

test('sessionReadableSql can lock the qualifying private-member row for a mutation', () => {
 const sql = core.sessionReadableSql('s', '$2', { lockMembership: true });
 assert.match(sql, /from chat_session_members csm[\s\S]*for share/);
});

test('the row-at-a-time gate rejects a deleted conversation before privacy membership', async () => {
 await assert.rejects(
  core.enforceSessionReadAccess({
   userId: OWNER,
   sessionId: DM,
   sessionRow: {
    id: DM,
    visibility: 'private',
    folder: 'Direct messages',
    deleted_at: '2026-07-31T12:00:00.000Z',
   },
   db: async () => {
    throw new Error('a complete session row must not trigger a second lookup');
   },
  }),
  { status: 404, message: 'Conversation not found' },
 );
});

test('the row-at-a-time gate re-reads a partial session row before deciding privacy', async () => {
 const reads = [];
 await assert.rejects(
  core.enforceSessionReadAccess({
   userId: OUTSIDER,
   sessionId: DM,
   // Having the deletion marker is not enough: without visibility/folder this
   // row cannot prove that the conversation is workspace-visible.
   sessionRow: { id: DM, deleted_at: null },
   db: async (sql) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    reads.push(normalized);
    if (normalized.startsWith('select id, visibility, folder, deleted_at from chat_sessions')) {
     return [{
      id: DM,
      visibility: 'private',
      folder: 'Direct messages',
      deleted_at: null,
     }];
    }
    if (normalized.startsWith('select 1 from chat_session_members')) return [];
    throw new Error(`Unexpected session access query: ${sql}`);
   },
  }),
  { status: 403, message: 'This conversation is private' },
 );
 assert.match(reads[0], /visibility, folder, deleted_at/);
 assert.ok(reads.some((sql) => sql.startsWith('select 1 from chat_session_members')));
});

test('appendSessionAccessClause constrains every workspace-wide session-bearing result', () => {
 const base = { clause: ' WHERE "chat_sessions"."workspace_id" = $1', params: ['w1'] };
 const sessions = core.appendSessionAccessClause({ ...base, params: [...base.params] }, OWNER, 'chat_sessions');
 assert.match(sessions.clause, /EXISTS \(SELECT 1 FROM chat_sessions cs WHERE cs\.id = "chat_sessions"\."id"/);
 assert.deepEqual(sessions.params, ['w1', OWNER], 'the user id is bound, never interpolated');

 const messages = core.appendSessionAccessClause({ clause: '', params: [] }, OWNER, 'messages');
 assert.match(messages.clause, /cs\.id = "messages"\."session_id"/, 'messages joins through session_id');
 assert.match(messages.clause, /^ WHERE /, 'an empty base clause still produces a valid WHERE');

 const permissionRequests = core.appendSessionAccessClause(
  { clause: ' WHERE "agent_permission_requests"."workspace_id" = $1', params: ['w1'] },
  OWNER,
  'agent_permission_requests',
 );
 assert.match(
  permissionRequests.clause,
  /cs\.id = "agent_permission_requests"\."session_id"/,
  'permission requests inherit the privacy of the conversation holding the tool call',
 );
 assert.match(
  permissionRequests.clause,
  /"agent_permission_requests"\."session_id" IS NULL OR EXISTS/,
  'legacy unattached requests keep their previous workspace visibility',
 );
 assert.deepEqual(permissionRequests.params, ['w1', OWNER]);

 for (const table of ['huddles', 'huddle_events']) {
  const scoped = core.appendSessionAccessClause(
   { clause: ` WHERE "${table}"."workspace_id" = $1`, params: ['w1'] },
   OWNER,
   table,
  );
  assert.match(
   scoped.clause,
   new RegExp(`cs\\.id = "${table}"\\."session_id"`),
   `${table} must inherit the host session's privacy on workspace-wide lists`,
  );
  assert.deepEqual(scoped.params, ['w1', OWNER]);
 }

 for (const table of ['thread_items', 'agent_jobs', 'agent_schedules']) {
  const scoped = core.appendSessionAccessClause(
   { clause: ` WHERE "${table}"."workspace_id" = $1`, params: ['w1'] },
   OWNER,
   table,
  );
  assert.match(
   scoped.clause,
   new RegExp(`cs\\.id = "${table}"\\."session_id"`),
   `${table} must inherit its source conversation on a workspace-wide list`,
  );
  assert.doesNotMatch(
   scoped.clause,
   new RegExp(`"${table}"\\."session_id" IS NULL OR EXISTS`),
   `${table} has no workspace-visible legacy/null row class`,
  );
  assert.deepEqual(scoped.params, ['w1', OWNER]);
 }

 // Untouched tables must come back byte-identical, or this helper would start
 // silently filtering things that have nothing to do with sessions.
 const other = { clause: ' WHERE x = $1', params: ['v'] };
 const passthrough = core.appendSessionAccessClause(other, OWNER, 'tasks');
 assert.equal(passthrough, other);
});

// ---------------------------------------------------------------------------
// The MCP surface
// ---------------------------------------------------------------------------

test('an AGENT is scoped by participation, a human by membership, and a workspace principal to visible sessions', () => {
 // The core product loop: an agent must keep reading its own DM.
 // chat_session_members holds USER ids and an agent is not a user, so the two
 // identities cannot share a branch.
 const { buildTools, mcpSessionScopeSql } = require('../server/mcp.cjs').__test;
 assert.ok(typeof buildTools === 'function');
 assert.ok(typeof mcpSessionScopeSql === 'function');

 const mcpSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/mcp.cjs'), 'utf8');
 // Source-text, because these branches are inside a SQL string builder that is
 // not otherwise reachable from a unit test. The floors below are what stop
 // this becoming a regex that quietly matches nothing.
 assert.match(mcpSrc, /function mcpSessionScopeSql/);
 assert.match(mcpSrc, /identity\?\.kind === 'agent' && identity\.agentId/);
 assert.match(mcpSrc, /mp->>'agent_id'/, 'the agent branch must key on the roster, not on members');

 // A workspace token is a control-plane principal, not a user session. It gets
 // the open-session predicate with no membership bind and therefore cannot read
 // an owner's or member's private session.
 const workspaceParams = [];
 const workspaceScope = mcpSessionScopeSql(
  { kind: 'workspace', workspaceId: WORKSPACE, ownerUserId: OWNER },
  's',
  workspaceParams,
 );
 assert.deepEqual(workspaceParams, [], 'workspace scope must not bind any borrowed user id');
 assert.doesNotMatch(workspaceScope, /chat_session_members/);
 assert.match(workspaceScope, /visibility/);
 assert.match(workspaceScope, /Direct messages/);
 assert.doesNotMatch(mcpSrc, /kind === 'workspace' && identity\.ownerUserId/);

 const userParams = [];
 const userScope = mcpSessionScopeSql({ kind: 'user', userId: OWNER }, 's', userParams);
 assert.deepEqual(userParams, [OWNER]);
 assert.match(userScope, /chat_session_members/, 'a real user keeps their membership branch');

 // Every tool that names a channel must go through the gate.
 const callSites = mcpSrc.match(/assertChannelInWorkspace\(db, \w+, identity\)/g) || [];
 assert.ok(callSites.length >= 4, `expected the channel gate on every naming tool, found ${callSites.length}`);
 // …and it must take the identity, so a new caller cannot pass a bare
 // workspace id and skip the private-session half.
 assert.match(mcpSrc, /async function assertChannelInWorkspace\(db, channelId, identity\)/);
 assert.equal(
  (mcpSrc.match(/assertChannelInWorkspace\(db, \w+, identity\.workspaceId\)/g) || []).length, 0,
  'no call site may still pass only a workspace id',
 );

 // Taking the identity is not the same as USING it. Scoped to the gate's own
 // body: without this, replacing its predicate with a constant left every
 // assertion above green, because the other tools have their own copies of the
 // same call and satisfied the file-wide match.
 const gateStart = mcpSrc.indexOf('async function assertChannelInWorkspace');
 const gateBody = mcpSrc.slice(gateStart, mcpSrc.indexOf('\n}', gateStart));
 assert.match(
  gateBody,
  /const scope = mcpSessionScopeSql\(identity, 'chat_sessions', params\);/,
  'the channel gate must build its scope from the identity, not from a constant',
 );
 assert.match(gateBody, /and \$\{scope\}/, 'and it must actually place that scope in the WHERE clause');
});

// ---------------------------------------------------------------------------
// The realtime fanout
// ---------------------------------------------------------------------------

test('a private session row is fanned out to its members only', async () => {
 // Subscribing is gated, but `chat_sessions` filtered on workspace_id is a
 // LEGITIMATE subscription — it is how the sidebar stays live — so every
 // matching row would otherwise be pushed to every socket in the workspace.
 // Opening a DM would then publish its title and roster to everyone, which is
 // the disclosure the bootstrap payload already withholds.
 const { createRealtime } = require('../server/realtime.cjs');

 const sent = [];
 // sendWs is internal to createRealtime, so delivery is captured through a fake
 // socket rather than an injected sender — readyState 1 is what makes it "open".
 const socket = (userId) => ({
  userId,
  readyState: 1,
  subscriptions: [{ type: 'db_changes', table: 'chat_sessions', filter: 'workspace_id=eq.w1' }],
  send: (raw) => sent.push({ userId, id: JSON.parse(raw).payload?.new?.id }),
 });
 const sockets = [socket(OWNER), socket(OUTSIDER)];

 const realtime = createRealtime({
  ensureTable: (t) => t,
  forbidden: (m) => Object.assign(new Error(m), { status: 403 }),
  enqueueFlowWebhookEvents: async () => {},
  enqueueAutomationRuns: async () => [],
  logMessageActivity: () => {},
  isPrivateSessionRow: (row) => String(row.visibility || '') === 'private' || String(row.folder || '') === 'Direct messages',
  sessionMemberUserIds: async (id) => (id === DM ? new Set([OWNER]) : new Set()),
 });
 for (const ws of sockets) realtime.registerTestWebsocketClient(ws);

 // A public channel reaches both sockets — the ordinary path must be untouched.
 realtime.notifyDbSubscribers('chat_sessions', 'INSERT', [{ id: CHANNEL, workspace_id: 'w1', folder: 'General', visibility: 'workspace' }]);
 assert.deepEqual(sent.map((s) => s.userId).sort(), [OUTSIDER, OWNER].sort(), 'a channel still reaches everyone subscribed');

 sent.length = 0;
 realtime.notifyDbSubscribers('chat_sessions', 'INSERT', [{ id: DM, workspace_id: 'w1', folder: 'Direct messages', visibility: 'private' }]);
 // The private lane is async and fire-and-forget, like emitAgentStatus.
 await new Promise((resolve) => setTimeout(resolve, 50));
 assert.deepEqual(sent.map((s) => s.userId), [OWNER], 'only the member receives a private session row');
});

test('a private row with an unresolvable member set is sent to nobody', async () => {
 // Fail CLOSED. "Deliver anyway when the lookup fails" would publish exactly
 // what this withholds.
 const { createRealtime } = require('../server/realtime.cjs');
 const sent = [];
 const realtime = createRealtime({
  ensureTable: (t) => t,
  forbidden: (m) => Object.assign(new Error(m), { status: 403 }),
  enqueueFlowWebhookEvents: async () => {},
  enqueueAutomationRuns: async () => [],
  logMessageActivity: () => {},
  isPrivateSessionRow: () => true,
  sessionMemberUserIds: async () => { throw new Error('db down'); },
 });
 realtime.registerTestWebsocketClient({
  userId: OWNER,
  readyState: 1,
  subscriptions: [{ type: 'db_changes', table: 'chat_sessions', filter: 'workspace_id=eq.w1' }],
  send: (raw) => sent.push({ userId: OWNER, id: JSON.parse(raw).payload?.new?.id }),
 });
 realtime.notifyDbSubscribers('chat_sessions', 'INSERT', [{ id: DM, workspace_id: 'w1', visibility: 'private' }]);
 await new Promise((resolve) => setTimeout(resolve, 50));
 assert.equal(sent.length, 0, 'a failed membership lookup must withhold, never broadcast');
});

test('message fanout reauthorizes the current session audience after a public channel becomes private', async () => {
 const { createRealtime } = require('../server/realtime.cjs');
 let audience = { memberUserIds: null };
 const realtime = createRealtime({
  ensureTable: (table) => table,
  forbidden: (message) => Object.assign(new Error(message), { status: 403 }),
  enqueueFlowWebhookEvents: async () => {},
  enqueueAutomationRuns: async () => [],
  logMessageActivity: () => {},
  sessionRealtimeAudience: async (sessionId) => (
   sessionId === CHANNEL ? audience : null
  ),
 });
 const socket = (userId) => realtime.registerTestWebsocketClient({
  userId,
  readyState: 1,
  subscriptions: [{
   type: 'db_changes',
   table: 'messages',
   event: '*',
   schema: 'public',
   filter: `session_id=eq.${CHANNEL}`,
  }],
  sent: [],
  send(raw) { this.sent.push(JSON.parse(raw)); },
 });
 const member = socket(OWNER);
 const outsider = socket(OUTSIDER);
 const row = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  session_id: CHANNEL,
  role: 'user',
  sender_kind: 'user',
  sender_id: OWNER,
  content: 'current-audience proof',
 };

 realtime.notifyDbSubscribers('messages', 'INSERT', [row]);
 await new Promise((resolve) => setTimeout(resolve, 20));
 assert.equal(member.sent.length, 1, 'an open channel still reaches a subscribed workspace reader');
 assert.equal(outsider.sent.length, 1, 'open-channel fanout remains unchanged');

 member.sent.length = 0;
 outsider.sent.length = 0;
 audience = { memberUserIds: new Set([OWNER]) };
 // The same bindings survive. Only the current audience resolver changes,
 // matching a privacy update committed by the other backend process.
 realtime.notifyDbSubscribers('messages', 'INSERT', [{ ...row, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }]);
 await new Promise((resolve) => setTimeout(resolve, 20));
 assert.equal(member.sent.length, 1, 'a current private-session member still receives the message');
 assert.equal(outsider.sent.length, 0, 'a socket authorized while public is not authorized forever');

 member.sent.length = 0;
 audience = null;
 realtime.notifyDbSubscribers('messages', 'INSERT', [{ ...row, id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }]);
 await new Promise((resolve) => setTimeout(resolve, 20));
 assert.equal(member.sent.length, 0, 'an unresolvable current audience fails closed');
});

test('aggregate reads and item-id-only thread updates carry the session scope', () => {
 const mcpSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '../server/mcp.cjs'), 'utf8');
 // search_messages is the widest read in the MCP surface — it spans every
 // session at once, and was returning matches out of other people's DMs.
 const search = mcpSrc.slice(mcpSrc.indexOf("name: 'search_messages'"));
 assert.match(search.slice(0, 2000), /mcpSessionScopeSql\(identity, 's', params\)/);
 const list = mcpSrc.slice(mcpSrc.indexOf("name: 'list_channels'"));
 assert.match(list.slice(0, 2000), /mcpSessionScopeSql\(identity, 'chat_sessions', params\)/);
 const updateThreadItem = mcpSrc.slice(mcpSrc.indexOf("name: 'update_thread_item'"));
 assert.match(
  updateThreadItem.slice(0, 2500),
  /assertChannelInWorkspace\(db, existing\[0\]\.session_id, identity\)/,
  'an item-id-only update must resolve and gate its parent session before returning private thread data',
 );
});
