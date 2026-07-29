// ============================================================================
// tests/dm-scope-assumption.test.cjs
// ----------------------------------------------------------------------------
// S1 — read authorization in agensis has exactly ONE granularity: the workspace.
//
// This file does not fix anything. It states the current answer out loud, in
// executable form, because that answer is currently carried by a single comment
// (server/index.cjs: "Workspaces are effectively single-human, so the DM keys on
// the agent alone") that any future change can silently invalidate.
//
// The uncomfortable assertion is the FIRST one: a workspace member holding only
// `viewer` — the weakest role — resolves and passes the access gate for the
// messages of ANY session in that workspace, including a DM with an agent.
// Below the workspace there is no ACL, no participant check, and no
// chat_sessions-level capability anywhere in the codebase. Scoping happens
// because the SQL narrows to the session the caller asked for, NOT because a
// permission check said that caller may see it.
//
// WHY THIS IS WORTH PINNING RATHER THAN FIXING (see the pack's section 3.3):
// a real fix is a chat_session_members table, a new capability, a migration for
// 1000+ existing sessions, and a rewrite of every read path. That is a product
// decision about what a DM means here, not a bug fix. Worse, a PARTIAL fix — a
// per-session check on one path and not the others — is strictly worse than the
// current uniform, documented behaviour.
//
// The assumption is, however, no longer hypothetical. Checked against the live
// database while this was written: one workspace already has two distinct human
// members, and four of its sessions are Direct messages. So "effectively
// single-human" is already false for one workspace today.
//
// If someone later adds a per-session read check, the first test here goes RED
// and they are forced to update AGENTS.md in the same change. That is the whole
// point, and it is the desired outcome in either direction.
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

// Deliberately the SAME mock shape tests/backend-rbac.test.cjs uses, and
// deliberately NOT a reimplementation of the membership lookup: a stub that
// restates the rule would measure the stub. This only answers the queries
// backend-core issues, from fixture data.
function makeDb({ owners = {}, roles = {}, sessions = {} } = {}) {
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
  if (n.startsWith('select workspace_id from chat_sessions where id = $1')) {
   const ws = sessions[params[0]];
   return ws ? [{ workspace_id: ws }] : [];
  }
  const m = n.match(/^select workspace_id from "?([a-z_]+)"? where id = \$1 limit 1/);
  if (m) return [];
  if (n.includes('with recursive chain as')) return [];
  throw new Error(`Unexpected SQL in test: ${sql}`);
 }
 return db;
}

const WS = 'ws-1';
const VIEWER = 'viewer-1';
// Two sessions in one workspace. One is a channel; one is somebody's DM with an
// agent. Nothing in the authorization path can tell them apart.
const CHANNEL_SESSION = 'sess-channel';
const DM_SESSION = 'sess-dm';

const db = () => makeDb({
 owners: { [WS]: 'owner-1' },
 roles: { [`${WS}:${VIEWER}`]: 'viewer' },
 sessions: { [CHANNEL_SESSION]: WS, [DM_SESSION]: WS },
});

test('a VIEWER may read any session in the workspace, including a DM', async () => {
 // THE ASSERTION THAT DOCUMENTS THE GAP. Both of these resolve and neither
 // throws. The DM is not more protected than the channel, because the only
 // check performed is "may this user read this WORKSPACE".
 await assert.doesNotReject(() => core.enforceDbOperationAccess({
  userId: VIEWER, table: 'messages', op: 'select',
  filters: [eq('session_id', CHANNEL_SESSION)], db: db(),
 }));
 await assert.doesNotReject(() => core.enforceDbOperationAccess({
  userId: VIEWER, table: 'messages', op: 'select',
  filters: [eq('session_id', DM_SESSION)], db: db(),
 }));
});

test('the scope comes from the FILTER, not from a permission on the session', async () => {
 // A messages select with no filter cannot be resolved to a workspace, so it is
 // refused outright. This is what makes the system fail-closed: there is no way
 // to express "give me every message", only "give me this session's".
 await assert.rejects(
  () => core.enforceDbOperationAccess({ userId: VIEWER, table: 'messages', op: 'select', filters: [], db: db() }),
  (error) => error.status === 400,
  'an unscoped messages select must be refused, not silently widened',
 );
});

test('messages is absent from WORKSPACE_SCOPED_TABLES ON PURPOSE', async () => {
 // `messages` has no workspace_id column, so it cannot be resolved by the
 // id-filter fallback the way a scoped table can. Adding it to the set would
 // make `select messages where id = X` resolvable and therefore permitted,
 // which is a widening — the fallback issues `select workspace_id from
 // messages`, a column that does not exist.
 assert.ok(
  !core.WORKSPACE_SCOPED_TABLES.has('messages'),
  'messages must stay out of the scoped set: it has no workspace_id to resolve',
 );

 // Consequence: a select filtered ONLY on messages.id is refused.
 await assert.rejects(
  () => core.enforceDbOperationAccess({ userId: VIEWER, table: 'messages', op: 'select', filters: [eq('id', 'msg-1')], db: db() }),
  (error) => error.status === 400,
  'an id-only messages filter has no resolvable workspace, so it must be refused',
 );
});

test('a non-member is refused even with a valid session filter', async () => {
 // The workspace check is real; it is the GRANULARITY that is the finding, not
 // the absence of a check. Without this assertion the file could pass against a
 // gate that permits everything.
 await assert.rejects(
  () => core.enforceDbOperationAccess({
   userId: 'stranger-1', table: 'messages', op: 'select',
   filters: [eq('session_id', DM_SESSION)], db: db(),
  }),
  (error) => error.status === 403,
 );
});

test('the assumption is written down where a reader will find it', () => {
 const fs = require('node:fs');
 const agents = fs.readFileSync(path.resolve(__dirname, '../AGENTS.md'), 'utf8');
 // A comment at the DM creation site is not enough — that is how this stayed
 // invisible. If the behaviour changes, this file and AGENTS.md move together.
 assert.match(
  agents,
  /read authorization is workspace-granular/i,
  'AGENTS.md must state the read-authorization granularity',
 );
 assert.match(
  agents,
  /DM privacy is not enforced/i,
  'AGENTS.md must say plainly that DMs are not private within a workspace',
 );
});
