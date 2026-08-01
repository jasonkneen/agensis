'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 hashControllerToken,
 requireWorkspaceOwner,
 createControllerCredential,
 verifyControllerToken,
 revokeController,
 controllerOwnsAgent,
} = require('../server/controller-credentials.cjs');

function scriptedDb(steps) {
 const calls = [];
 return {
  calls,
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   calls.push({ sql: normalized, params });
   const index = steps.findIndex((step) => (
    typeof step.match === 'string' ? normalized.includes(step.match) : step.match.test(normalized)
   ));
   if (index < 0) throw new Error(`Unexpected SQL: ${normalized}`);
   const [step] = steps.splice(index, 1);
   return typeof step.rows === 'function' ? step.rows(params) : step.rows;
  },
 };
}

test('workspace-control issuance is owner-only', async () => {
 const ownerDb = scriptedDb([{ match: 'select id, user_id from workspaces', rows: [{ id: 'w1', user_id: 'u1' }] }]);
 assert.equal((await requireWorkspaceOwner({ db: ownerDb, userId: 'u1', workspaceId: 'w1' })).id, 'w1');

 const adminDb = scriptedDb([{ match: 'select id, user_id from workspaces', rows: [{ id: 'w1', user_id: 'u1' }] }]);
 await assert.rejects(
  requireWorkspaceOwner({ db: adminDb, userId: 'admin-member', workspaceId: 'w1' }),
  error => error.status === 403,
 );
});

test('controller creation stores only a hash and returns plaintext once', async () => {
 let storedHash = '';
 const db = scriptedDb([{
  match: 'insert into workspace_controllers',
  rows: params => {
   storedHash = params[2];
   return [{
    id: 'c1',
    workspace_id: 'w1',
    name: params[1],
    scopes: params[3],
    status: 'active',
    expires_at: params[5],
   }];
  },
 }]);
 const created = await createControllerCredential({
  db,
  workspaceId: 'w1',
  name: 'Build farm',
  scopes: ['agents:register', 'resources:create'],
  expiresAt: new Date(Date.now() + 86_400_000),
  createdBy: 'u1',
 });
 assert.match(created.token, /^agc_/);
 assert.equal(storedHash, hashControllerToken(created.token));
 assert.equal(db.calls[0].params.includes(created.token), false);
 assert.equal('token_hash' in created.controller, false);
});

test('child credentials cannot escalate or outlive their parent', async () => {
 const parent = {
  id: 'parent',
  workspace_id: 'w1',
  scopes: ['agents:register'],
  expires_at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
 };
 const escalationDb = scriptedDb([{ match: 'from workspace_controllers', rows: [parent] }]);
 await assert.rejects(
  createControllerCredential({
   db: escalationDb,
   workspaceId: 'w1',
   name: 'Child',
   scopes: ['resources:create'],
   expiresAt: new Date(Date.now() + 86_400_000),
   parentControllerId: 'parent',
  }),
  error => error.status === 403 && /exceed/.test(error.message),
 );

 const expiryDb = scriptedDb([{ match: 'from workspace_controllers', rows: [parent] }]);
 await assert.rejects(
  createControllerCredential({
   db: expiryDb,
   workspaceId: 'w1',
   name: 'Child',
   scopes: ['agents:register'],
   expiresAt: new Date(Date.now() + 3 * 86_400_000),
   parentControllerId: 'parent',
  }),
  error => error.status === 403 && /outlive/.test(error.message),
 );
});

test('controller verification is prefix, status, expiry, and scope fail-closed', async () => {
 const token = 'agc_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
 const db = scriptedDb([
  {
   match: 'from workspace_controllers',
   rows: [{
    id: 'c1',
    workspace_id: 'w1',
    name: 'Farm',
    scopes: ['agents:register', 'resources:create'],
    status: 'active',
   }],
  },
  { match: 'update workspace_controllers', rows: [] },
 ]);
 assert.deepEqual(await verifyControllerToken({ db, token }), {
  kind: 'controller',
  controllerId: 'c1',
  workspaceId: 'w1',
  name: 'Farm',
  scopes: ['agents:register', 'resources:create'],
 });
 assert.equal(db.calls[0].params[0], hashControllerToken(token));

 const invalidScopes = scriptedDb([{
  match: 'from workspace_controllers',
  rows: [{ id: 'c1', workspace_id: 'w1', scopes: ['roles:grant'] }],
 }]);
 assert.equal(await verifyControllerToken({ db: invalidScopes, token }), null);
 assert.equal(await verifyControllerToken({ db: invalidScopes, token: 'agw_not-a-controller' }), null);
});

test('controller revocation and agent ownership are explicit row predicates', async () => {
 const revokeDb = scriptedDb([{
  match: 'with recursive controller_tree',
  rows: [
   {
    id: 'child',
    workspace_id: 'w1',
    name: 'Child',
    scopes: ['agents:register'],
    status: 'revoked',
    parent_controller_id: 'c1',
   },
   { id: 'c1', workspace_id: 'w1', name: 'Farm', scopes: ['agents:register'], status: 'revoked' },
  ],
 }]);
 assert.equal((await revokeController({ db: revokeDb, workspaceId: 'w1', controllerId: 'c1' })).status, 'revoked');
 assert.match(revokeDb.calls[0].sql, /join controller_tree parent on child\.parent_controller_id = parent\.id/);
 assert.match(revokeDb.calls[0].sql, /where id in \(select id from controller_tree\)/);

 const ownDb = scriptedDb([{ match: 'from workspace_agents', rows: [{ id: 'a1' }] }]);
 assert.equal(await controllerOwnsAgent({
  db: ownDb,
  identity: { kind: 'controller', workspaceId: 'w1', controllerId: 'c1' },
  agentId: 'a1',
 }), true);
 assert.deepEqual(ownDb.calls[0].params, ['a1', 'w1', 'c1']);
});
