'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { mountMembersInvitesRoutes } = require('../server/members-invites-routes.cjs');

const WORKSPACE = '00000000-0000-4000-8000-000000000001';
const INVITER = '00000000-0000-4000-8000-000000000002';
const ALICE = '00000000-0000-4000-8000-000000000003';
const BOB = '00000000-0000-4000-8000-000000000004';

function copy(value) {
 return value == null ? value : JSON.parse(JSON.stringify(value));
}

function makeDb({
 storedToken = 'hash:secret',
 status = 'pending',
 acceptedBy = null,
 expiresAt = new Date(Date.now() + 60_000).toISOString(),
 raceClaim = false,
 failMemberInsert = false,
 ownerUserId = null,
 members = [],
} = {}) {
 const state = {
  invite: {
   id: '00000000-0000-4000-8000-000000000010',
   workspace_id: WORKSPACE,
   token: storedToken,
   email: 'person@example.test',
   role: 'editor',
   status,
   created_by: INVITER,
   accepted_by: acceptedBy,
   accepted_at: acceptedBy ? new Date().toISOString() : null,
   expires_at: expiresAt,
  },
  workspace: { id: WORKSPACE, name: 'Acme', user_id: ownerUserId },
  members: copy(members),
 };
 const queries = [];
 let claimArrivals = 0;
 let releaseClaims;
 const claimsReady = raceClaim
  ? new Promise(resolve => { releaseClaims = resolve; })
  : null;

 async function unsafe(sql, params = []) {
  const raw = String(sql).replace(/\s+/g, ' ').trim();
  const q = raw.toLowerCase();
  queries.push({ sql: raw, params: copy(params) });

  if (q.startsWith('update workspace_invites') && q.includes("set status = 'accepted'")) {
   if (raceClaim) {
    claimArrivals += 1;
    if (claimArrivals === 2) releaseClaims();
    await claimsReady;
   }
   const [hashed, plaintext, userId] = params;
   const invite = state.invite;
   const tokenMatches = invite && (invite.token === hashed || invite.token === plaintext);
   const unexpired = invite?.expires_at == null || new Date(invite.expires_at).getTime() > Date.now();
   if (!tokenMatches || invite.status !== 'pending' || !unexpired) return [];
   state.invite = {
    ...invite,
    status: 'accepted',
    accepted_by: userId,
    accepted_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
   };
   return [copy(state.invite)];
  }

  if (q.startsWith('select *,') && q.includes('from workspace_invites')) {
   const [hashed, plaintext] = params;
   if (!state.invite || (state.invite.token !== hashed && state.invite.token !== plaintext)) return [];
   return [{
    ...copy(state.invite),
    invite_expired: state.invite.expires_at != null
     && new Date(state.invite.expires_at).getTime() <= Date.now(),
   }];
  }

  if (q.startsWith('insert into workspace_members')) {
   if (failMemberInsert) throw new Error('membership insert failed');
   const [workspaceId, userId, role, invitedBy] = params;
   if (state.workspace.id === workspaceId && state.workspace.user_id === userId) return [];
   if (state.members.some(row => row.workspace_id === workspaceId && row.user_id === userId)) return [];
   const row = {
    id: `member-${state.members.length + 1}`,
    workspace_id: workspaceId,
    user_id: userId,
    role,
    invited_by: invitedBy,
   };
   state.members.push(row);
   return [copy(row)];
  }

  if (q.startsWith('select 1 as has_access')) {
   const [workspaceId, userId] = params;
   const owns = state.workspace.id === workspaceId && state.workspace.user_id === userId;
   const member = state.members.some(row => row.workspace_id === workspaceId && row.user_id === userId);
   return owns || member ? [{ has_access: 1 }] : [];
  }

  if (q.startsWith('select id, name from workspaces')) {
   return params[0] === state.workspace.id
    ? [{ id: state.workspace.id, name: state.workspace.name }]
    : [];
  }

  throw new Error(`Unexpected SQL: ${raw}`);
 }

 const db = {
  state,
  queries,
  async begin(fn) {
   const before = copy(state);
   try {
    return await fn({ unsafe });
   } catch (error) {
    state.invite = before.invite;
    state.workspace = before.workspace;
    state.members = before.members;
    throw error;
   }
  },
 };
 return db;
}

async function withServer(db, fn) {
 const notifications = [];
 const app = express();
 app.use(express.json());
 const requireAuth = (req, res, next) => {
  const userId = String(req.headers['x-test-user'] || '').trim();
  if (!userId) return res.status(401).json({ data: null, error: { message: 'Unauthorized' } });
  req.userId = userId;
  next();
 };
 mountMembersInvitesRoutes(app, {
  requireAuth,
  jsonError(res, status, error) {
   return res.status(status).json({ data: null, error: { message: error.message } });
  },
  enforceWorkspaceRole: async () => 'owner',
  getDb: () => db,
  notifyDbSubscribers(table, eventType, rows) {
   notifications.push({ table, eventType, rows: copy(rows) });
  },
  hashAgentToken: token => `hash:${token}`,
  inviteTokenLookupParams: token => [`hash:${token}`, token],
  clientIpFromReq: () => '127.0.0.1',
 });

 const server = http.createServer(app);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const { port } = server.address();
 try {
  return await fn(`http://127.0.0.1:${port}`, notifications);
 } finally {
  await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
 }
}

function accept(baseUrl, token, userId) {
 return fetch(`${baseUrl}/backend/invites/${encodeURIComponent(token)}/accept`, {
  method: 'POST',
  headers: { 'x-test-user': userId, 'Content-Type': 'application/json' },
 });
}

test('accepts a hash-at-rest invite and provisions one member', async () => {
 const db = makeDb();
 await withServer(db, async (baseUrl, notifications) => {
  const response = await accept(baseUrl, 'secret', ALICE);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
   data: { workspaceId: WORKSPACE, workspace: { id: WORKSPACE, name: 'Acme' } },
   error: null,
  });
  assert.equal(db.state.invite.status, 'accepted');
  assert.equal(db.state.invite.accepted_by, ALICE);
  assert.deepEqual(db.state.members.map(({ user_id, role, invited_by }) => ({ user_id, role, invited_by })), [
   { user_id: ALICE, role: 'editor', invited_by: INVITER },
  ]);
  assert.deepEqual(notifications.map(({ table, eventType }) => [table, eventType]), [
   ['workspace_members', 'INSERT'],
   ['workspace_invites', 'UPDATE'],
  ]);
  const claim = db.queries[0].sql.toLowerCase();
  assert.ok(claim.startsWith('update workspace_invites'), 'the first database action must be the claim');
  assert.match(claim, /and status = 'pending'/);
  assert.match(claim, /expires_at is null or expires_at >= now\(\)/);
 });
});

test('acceptance retains compatibility with legacy plaintext invite rows', async () => {
 const db = makeDb({ storedToken: 'legacy-secret' });
 await withServer(db, async baseUrl => {
  const response = await accept(baseUrl, 'legacy-secret', ALICE);
  assert.equal(response.status, 200);
  assert.equal(db.state.invite.accepted_by, ALICE);
  assert.equal(db.state.members[0].user_id, ALICE);
 });
});

test('a null expiry remains valid and an unknown token remains a write-free 404', async t => {
 await t.test('null expiry', async () => {
  const db = makeDb({ expiresAt: null });
  await withServer(db, async baseUrl => {
   assert.equal((await accept(baseUrl, 'secret', ALICE)).status, 200);
   assert.equal(db.state.invite.accepted_by, ALICE);
  });
 });

 await t.test('unknown token', async () => {
  const db = makeDb();
  await withServer(db, async (baseUrl, notifications) => {
   const response = await accept(baseUrl, 'not-the-secret', ALICE);
   assert.equal(response.status, 404);
   assert.equal((await response.json()).error.message, 'Invite not found');
   assert.equal(db.state.invite.status, 'pending');
   assert.equal(db.state.members.length, 0);
   assert.equal(notifications.length, 0);
  });
 });
});

test('same-user acceptance is idempotent while a different user is refused', async () => {
 const db = makeDb();
 await withServer(db, async (baseUrl, notifications) => {
  assert.equal((await accept(baseUrl, 'secret', ALICE)).status, 200);
  assert.equal((await accept(baseUrl, 'secret', ALICE)).status, 200);
  const used = await accept(baseUrl, 'secret', BOB);
  assert.equal(used.status, 410);
  assert.equal((await used.json()).error.message, 'This invite has already been used');
  assert.equal(db.state.members.length, 1);
  assert.equal(db.state.members[0].user_id, ALICE);
  assert.equal(notifications.filter(event => event.table === 'workspace_members').length, 1);
  assert.equal(notifications.filter(event => event.table === 'workspace_invites').length, 1);
 });
});

test('acceptance preserves an existing member role and does not duplicate an owner row', async t => {
 await t.test('existing member', async () => {
  const existing = {
   id: 'member-existing',
   workspace_id: WORKSPACE,
   user_id: ALICE,
   role: 'viewer',
   invited_by: null,
  };
  const db = makeDb({ members: [existing] });
  await withServer(db, async (baseUrl, notifications) => {
   assert.equal((await accept(baseUrl, 'secret', ALICE)).status, 200);
   assert.equal(db.state.members.length, 1);
   assert.equal(db.state.members[0].role, 'viewer');
   assert.deepEqual(notifications.map(({ table, eventType }) => [table, eventType]), [
    ['workspace_invites', 'UPDATE'],
   ]);
  });
 });

 await t.test('workspace owner', async () => {
  const db = makeDb({ ownerUserId: ALICE });
  await withServer(db, async (baseUrl, notifications) => {
   assert.equal((await accept(baseUrl, 'secret', ALICE)).status, 200);
   assert.equal(db.state.members.length, 0);
   assert.deepEqual(notifications.map(({ table, eventType }) => [table, eventType]), [
    ['workspace_invites', 'UPDATE'],
   ]);
  });
 });
});

test('an accepted invite cannot add its recipient back after membership removal', async () => {
 const db = makeDb();
 await withServer(db, async (baseUrl, notifications) => {
  assert.equal((await accept(baseUrl, 'secret', ALICE)).status, 200);
  db.state.members = [];

  const replay = await accept(baseUrl, 'secret', ALICE);
  assert.equal(replay.status, 410);
  assert.equal((await replay.json()).error.message, 'This invite has already been used');
  assert.equal(db.state.members.length, 0);
  assert.equal(notifications.filter(event => event.table === 'workspace_members').length, 1);
  assert.equal(notifications.filter(event => event.table === 'workspace_invites').length, 1);
 });
});

test('revoked and expired invitations cannot provision membership', async t => {
 await t.test('revoked', async () => {
  const db = makeDb({ status: 'revoked' });
  await withServer(db, async (baseUrl, notifications) => {
   const response = await accept(baseUrl, 'secret', ALICE);
   assert.equal(response.status, 410);
   assert.equal((await response.json()).error.message, 'This invite has been revoked');
   assert.equal(db.state.members.length, 0);
   assert.equal(notifications.length, 0);
  });
 });

 await t.test('expired', async () => {
  const db = makeDb({ expiresAt: new Date(Date.now() - 60_000).toISOString() });
  await withServer(db, async (baseUrl, notifications) => {
   const response = await accept(baseUrl, 'secret', ALICE);
   assert.equal(response.status, 410);
   assert.equal((await response.json()).error.message, 'This invite has expired');
   assert.equal(db.state.invite.status, 'pending');
   assert.equal(db.state.members.length, 0);
   assert.equal(notifications.length, 0);
  });
 });
});

test('two users racing one pending invite cannot both gain membership', async () => {
 const db = makeDb({ raceClaim: true });
 await withServer(db, async (baseUrl, notifications) => {
  const [aliceResponse, bobResponse] = await Promise.all([
   accept(baseUrl, 'secret', ALICE),
   accept(baseUrl, 'secret', BOB),
  ]);
  const statuses = [aliceResponse.status, bobResponse.status].sort();
  assert.deepEqual(statuses, [200, 410]);
  assert.equal(db.state.members.length, 1);
  assert.equal(db.state.members[0].user_id, db.state.invite.accepted_by);
  assert.ok([ALICE, BOB].includes(db.state.invite.accepted_by));
  assert.ok(
   db.queries.slice(0, 2).every(({ sql }) => sql.toLowerCase().startsWith('update workspace_invites')),
   'both racing transactions must try the conditional claim before any read or provisioning',
  );
  assert.equal(notifications.filter(event => event.table === 'workspace_members').length, 1);
  assert.equal(notifications.filter(event => event.table === 'workspace_invites').length, 1);
 });
});

test('membership failure rolls back the claim and emits no realtime events', async () => {
 const db = makeDb({ failMemberInsert: true });
 await withServer(db, async (baseUrl, notifications) => {
  const response = await accept(baseUrl, 'secret', ALICE);
  assert.equal(response.status, 500);
  assert.equal(db.state.invite.status, 'pending');
  assert.equal(db.state.invite.accepted_by, null);
  assert.equal(db.state.members.length, 0);
  assert.equal(notifications.length, 0);
 });
});
