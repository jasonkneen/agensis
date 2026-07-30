// ============================================================================
// tests/dm-scope-assumption.test.cjs
// ----------------------------------------------------------------------------
// S1 — read authorization now has TWO granularities: the workspace, and the
// session below it.
//
// THIS FILE USED TO SAY THE OPPOSITE. Its first assertion read "a VIEWER may
// read any session in the workspace, including a DM", and it was written
// deliberately to go RED the day someone fixed that — so that nobody could
// change the behaviour without also changing the written record. That day is
// this one, and the assertion below is its inverse.
//
// WHAT CHANGED. `chat_sessions.visibility` marks a session 'private'; a private
// session is readable only by rows in `chat_session_members`. Every read path
// resolves a workspace and calls enforceWorkspaceRole(..., 'read') exactly as
// before — that check is necessary and unchanged — and then, for a private
// session, ALSO asks whether this caller is a member. The second gate only ever
// narrows: a channel behaves exactly as it did.
//
// WHY THE MIGRATION IS SAFE, since that was the real risk and not the gate: no
// DM in this schema had ever recorded a human (findOrCreateDirectSession stores
// the AGENT alone), so scoping to a participant list that was never populated
// would have hidden every DM from its own owner. Checked against production
// before designing: 76 DM rows, zero human participants, 75 of 76 created when
// the workspace owner was the only human in that workspace, and not one DM
// containing a message authored by a non-owner human. The backfill seeds the
// workspace owner, which restores exactly the access people already had.
//
// The mock below answers queries from fixture data and does NOT restate the
// rule — a stub that duplicates the WHERE clause measures the stub. The
// membership fixture is a plain list of (session, user) pairs; the SQL that
// decides what to do with it is the code under test.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let core;
test.before(async () => {
 core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.cjs')).href);
});

function eq(column, value) {
 return { column, operator: 'eq', value };
}

// Same mock shape tests/backend-rbac.test.cjs uses, extended with the two
// queries the session gate issues. `members` is a fixture of "sessionId:userId"
// keys — deliberately dumb, so this file cannot pass by re-implementing the
// check it is meant to be testing.
function makeDb({ owners = {}, roles = {}, sessions = {}, visibility = {}, folders = {}, members = new Set() } = {}) {
 async function db(sql, params = []) {
  const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
   return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
  }
  if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
   const role = roles[`${params[0]}:${params[1]}`];
   return role ? [{ role }] : [];
  }
  if (n.startsWith('select id from workspaces where id = $1')) {
   return params[0] ? [{ id: params[0] }] : [];
  }
  if (n.startsWith('select workspace_id') && n.includes('from chat_sessions')) {
   const ws = sessions[params[0]];
   return ws ? [{ workspace_id: ws }] : [];
  }
  // The session gate: fetch the row, then ask whether this user is a member.
  if (n.startsWith('select id, visibility, folder from chat_sessions where id = $1')) {
   if (!sessions[params[0]]) return [];
   return [{ id: params[0], visibility: visibility[params[0]] || 'workspace', folder: folders[params[0]] || 'General' }];
  }
  if (n.startsWith('select 1 from chat_session_members')) {
   return members.has(`${params[0]}:${params[1]}`) ? [{ ok: 1 }] : [];
  }
  const m = n.match(/^select workspace_id from "?([a-z_]+)"? where id = \$1 limit 1/);
  if (m) return [];
  if (n.includes('with recursive chain as')) return [];
  throw new Error(`Unexpected SQL in test: ${sql}`);
 }
 return db;
}

const WS = 'ws-1';
const OWNER = 'owner-1';
const VIEWER = 'viewer-1';
const CHANNEL_SESSION = 'sess-channel';
const DM_SESSION = 'sess-dm';

const db = () => makeDb({
 owners: { [WS]: OWNER },
 roles: { [`${WS}:${VIEWER}`]: 'viewer' },
 sessions: { [CHANNEL_SESSION]: WS, [DM_SESSION]: WS },
 visibility: { [DM_SESSION]: 'private' },
 folders: { [DM_SESSION]: 'Direct messages' },
 // The owner is the DM's member, exactly as the backfill seeds it.
 members: new Set([`${DM_SESSION}:${OWNER}`]),
});

const selectMessages = (userId, sessionId, database) => core.enforceDbOperationAccess({
 userId, table: 'messages', op: 'select', filters: [eq('session_id', sessionId)], db: database || db(),
});

test('a VIEWER may read a CHANNEL but NOT a DM they are not a member of', async () => {
 // THE INVERSE OF WHAT THIS FILE USED TO ASSERT. The workspace check passes in
 // both cases — the viewer really is a member of the workspace — so a failure
 // here is the session gate, not the workspace one.
 await assert.doesNotReject(() => selectMessages(VIEWER, CHANNEL_SESSION));
 await assert.rejects(
  () => selectMessages(VIEWER, DM_SESSION),
  (error) => error.status === 403,
  'a workspace member who is not a member of the DM must be refused',
 );
});

test("the DM's own member still reads it", async () => {
 // The half that matters more than the denial: the migration must not have
 // locked people out of their own conversations.
 await assert.doesNotReject(() => selectMessages(OWNER, DM_SESSION));
});

test('folder alone is enough to make a session private, without the column', async () => {
 // Fail-closed backstop. A DM-creating path that forgets `visibility` must not
 // produce a world-readable DM — isPrivateSessionRow ORs the two signals, and
 // this is the assertion that stops someone "simplifying" it to one.
 const noColumn = makeDb({
  owners: { [WS]: OWNER },
  roles: { [`${WS}:${VIEWER}`]: 'viewer' },
  sessions: { [DM_SESSION]: WS },
  visibility: {},                                   // column never set
  folders: { [DM_SESSION]: 'Direct messages' },
  members: new Set([`${DM_SESSION}:${OWNER}`]),
 });
 await assert.rejects(() => selectMessages(VIEWER, DM_SESSION, noColumn), (error) => error.status === 403);
});

test('visibility alone is enough, without the DM folder', async () => {
 // The other half of the OR, so neither signal can be dropped silently. This is
 // what covers a sub-thread / huddle transcript split out of a DM: those carry
 // 'private' but their folder is 'sub-thread' or 'huddle'.
 const derived = makeDb({
  owners: { [WS]: OWNER },
  roles: { [`${WS}:${VIEWER}`]: 'viewer' },
  sessions: { 'sess-sub': WS },
  visibility: { 'sess-sub': 'private' },
  folders: { 'sess-sub': 'sub-thread' },
  members: new Set([`sess-sub:${OWNER}`]),
 });
 await assert.rejects(() => selectMessages(VIEWER, 'sess-sub', derived), (error) => error.status === 403);
 await assert.doesNotReject(() => selectMessages(OWNER, 'sess-sub', derived));
});

test('the OWNER gets no implicit oversight — membership is what counts', async () => {
 // A deliberate product decision, pinned because it is the one a future reader
 // is most likely to "fix" by adding an owner bypass. An owner holds `manage`
 // and can GRANT themselves access, which leaves an audit row; reading silently
 // would be the same power with no trace.
 const notAMember = makeDb({
  owners: { [WS]: OWNER },
  sessions: { [DM_SESSION]: WS },
  visibility: { [DM_SESSION]: 'private' },
  folders: { [DM_SESSION]: 'Direct messages' },
  members: new Set(),                               // owner deliberately absent
 });
 await assert.rejects(() => selectMessages(OWNER, DM_SESSION, notAMember), (error) => error.status === 403);
});

test('an expired grant is not a grant', async () => {
 // Expiry is evaluated in SQL, so this asserts the predicate is actually part
 // of the query rather than something a caller is trusted to apply afterwards.
 let sawExpiryClause = false;
 const expiring = makeDb({
  owners: { [WS]: OWNER },
  roles: { [`${WS}:${VIEWER}`]: 'viewer' },
  sessions: { [DM_SESSION]: WS },
  visibility: { [DM_SESSION]: 'private' },
  folders: { [DM_SESSION]: 'Direct messages' },
  members: new Set(),
 });
 const wrapped = async (sql, params) => {
  if (String(sql).includes('chat_session_members')) {
   sawExpiryClause = /expires_at is null or expires_at > now\(\)/i.test(String(sql).replace(/\s+/g, ' '));
  }
  return expiring(sql, params);
 };
 await assert.rejects(() => selectMessages(VIEWER, DM_SESSION, wrapped), (error) => error.status === 403);
 assert.ok(sawExpiryClause, 'the membership lookup must filter expired grants in SQL, not in JS');
});

test('the scope still comes from the FILTER as well as the permission', async () => {
 // Unchanged from before the fix, and still load-bearing: an unscoped messages
 // select cannot be resolved to a workspace, so it is refused outright. The
 // session gate is an ADDITION to this, not a replacement.
 await assert.rejects(
  () => core.enforceDbOperationAccess({ userId: VIEWER, table: 'messages', op: 'select', filters: [], db: db() }),
  (error) => error.status === 400,
  'an unscoped messages select must be refused, not silently widened',
 );
});

test('messages is absent from WORKSPACE_SCOPED_TABLES ON PURPOSE', async () => {
 assert.ok(
  !core.WORKSPACE_SCOPED_TABLES.has('messages'),
  'messages must stay out of the scoped set: it has no workspace_id to resolve',
 );
 await assert.rejects(
  () => core.enforceDbOperationAccess({ userId: VIEWER, table: 'messages', op: 'select', filters: [eq('id', 'msg-1')], db: db() }),
  (error) => error.status === 400,
  'an id-only messages filter has no resolvable workspace, so it must be refused',
 );
});

test('a non-member of the WORKSPACE is still refused first', async () => {
 // The workspace check is untouched. Without this the file could pass against a
 // build where the session gate replaced the workspace gate instead of joining it.
 await assert.rejects(
  () => selectMessages('stranger-1', DM_SESSION),
  (error) => error.status === 403,
 );
});

test('chat_session_members is NOT reachable through the generic db route', () => {
 // The whole feature is theatre if a member can POST /backend/db/insert a row
 // granting themselves access. Same treatment as audit_log.
 assert.ok(
  !core.ALLOWED_TABLES.has('chat_session_members'),
  'chat_session_members must never be allowlisted: it would be a self-grant primitive',
 );
});

test('the new behaviour is written down where a reader will find it', () => {
 const fs = require('node:fs');
 const agents = fs.readFileSync(path.resolve(__dirname, '../AGENTS.md'), 'utf8');
 // The counterpart of the old assertion. AGENTS.md said "read authorization is
 // workspace-granular" and "DM privacy is not enforced"; if either sentence
 // survives the fix, the docs are actively lying to the next reader.
 assert.doesNotMatch(
  agents,
  /DM privacy is not enforced/i,
  'AGENTS.md still claims DM privacy is not enforced — it now is',
 );
 assert.match(
  agents,
  /chat_session_members/,
  'AGENTS.md must document the session-level read scope and where it lives',
 );
});
