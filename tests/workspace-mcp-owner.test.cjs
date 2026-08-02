'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

const WORKSPACE = 'workspace-1';
const OWNER = 'owner-1';
const ADMIN = 'admin-1';

test.afterEach(() => __test.resetTestState());

function makeDb() {
 const state = {
  ownerId: OWNER,
  autoApprove: false,
  tokenRotations: 0,
  autoApproveWrites: 0,
  calls: [],
 };
 return {
  state,
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   state.calls.push({ sql: normalized, params });
   if (normalized.startsWith('select value from app_settings')) {
    return params[0] === 'AUTH_SECRET' ? [{ value: 'workspace-mcp-owner-test-secret' }] : [];
   }
   if (normalized.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
   if (normalized.startsWith('select id, user_id from workspaces where id')) {
    return String(params[0]) === WORKSPACE
     ? [{ id: WORKSPACE, user_id: state.ownerId }]
     : [];
   }
   if (normalized.startsWith('select 1 from workspaces where id')) {
    return String(params[0]) === WORKSPACE && String(params[1]) === state.ownerId
     ? [{ ok: 1 }]
     : [];
   }
   if (normalized.startsWith('select role from workspace_members')) {
    return String(params[0]) === WORKSPACE && String(params[1]) === ADMIN
     ? [{ role: 'admin' }]
     : [];
   }
   if (normalized.includes('with recursive chain as')) return [];
   if (normalized.startsWith('select id, mcp_auto_approve')) {
    return String(params[0]) === WORKSPACE
     ? [{
      id: WORKSPACE,
      mcp_auto_approve: state.autoApprove,
      configured: state.tokenRotations > 0,
     }]
     : [];
   }
   if (normalized.startsWith('update workspaces set mcp_token_hash')) {
    state.tokenRotations += 1;
    return [{ id: WORKSPACE, mcp_auto_approve: state.autoApprove }];
   }
   if (normalized.startsWith('update workspaces set mcp_auto_approve')) {
    state.autoApproveWrites += 1;
    state.autoApprove = Boolean(params[1]);
    return [{ id: WORKSPACE, mcp_auto_approve: state.autoApprove }];
   }
   if (normalized.startsWith('insert into audit_log')) return [{ id: 'audit-1' }];
   return [];
  },
 };
}

async function withServer(run) {
 const app = createApp();
 const server = http.createServer(app);
 await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
 const { port } = server.address();
 try {
  return await run(`http://127.0.0.1:${port}`);
 } finally {
  await new Promise((resolve, reject) => {
   server.close((error) => (error ? reject(error) : resolve()));
  });
 }
}

function request(baseUrl, method, path, token, body) {
 return fetch(`${baseUrl}${path}`, {
  method,
  headers: {
   Authorization: `Bearer ${token}`,
   'Content-Type': 'application/json',
  },
  body: JSON.stringify(body || {}),
 });
}

test('the actual workspace owner can rotate the control-plane token and set auto-approve', async () => {
 const db = makeDb();
 __test.setTestDb(db);
 const token = await __test.issueToken(OWNER, '1');

 await withServer(async (baseUrl) => {
  const statusBefore = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/mcp-connection`, {
   headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(statusBefore.status, 200);
  const before = await statusBefore.json();
  assert.equal(before.data.configured, false);
  assert.ok(before.data.endpoint);
  assert.equal(before.data.token, undefined);

  const mint = await request(
   baseUrl,
   'POST',
   `/backend/workspaces/${WORKSPACE}/mcp-token`,
   token,
   {},
  );
  assert.equal(mint.status, 200);
  const minted = await mint.json();
  assert.match(minted.data.token, /^agw_/);
  assert.equal(minted.data.configured, true);

  const statusAfter = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/mcp-connection`, {
   headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(statusAfter.status, 200);
  const after = await statusAfter.json();
  assert.equal(after.data.configured, true);
  assert.equal(after.data.token, undefined, 'status never re-discloses the live token');

  const approve = await request(
   baseUrl,
   'PATCH',
   `/backend/workspaces/${WORKSPACE}/mcp-auto-approve`,
   token,
   { autoApprove: true },
  );
  assert.equal(approve.status, 200);
  assert.equal((await approve.json()).data.autoApprove, true);
 });

 assert.equal(db.state.tokenRotations, 1);
 assert.equal(db.state.autoApproveWrites, 1);
 assert.ok(
  db.state.calls.filter((call) => call.sql.startsWith('select id, user_id from workspaces where id')).length >= 2,
  'both privileged routes must resolve the canonical workspaces.user_id owner',
 );
});

test('an admin with manage cannot rotate the token or enable auto-approve', async () => {
 const db = makeDb();
 __test.setTestDb(db);

 // Establish that this fixture really is an admin with the manage capability;
 // the route must still use the stricter workspaces.user_id boundary.
 await assert.doesNotReject(
  () => __test.enforceWorkspaceRole(ADMIN, WORKSPACE, 'manage'),
  'the fixture admin must really hold manage before the stricter owner check is exercised',
 );
 const token = await __test.issueToken(ADMIN, '1');

 await withServer(async (baseUrl) => {
  const status = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/mcp-connection`, {
   headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(status.status, 403);

  const mint = await request(
   baseUrl,
   'POST',
   `/backend/workspaces/${WORKSPACE}/mcp-token`,
   token,
   {},
  );
  assert.equal(mint.status, 403);

  const approve = await request(
   baseUrl,
   'PATCH',
   `/backend/workspaces/${WORKSPACE}/mcp-auto-approve`,
   token,
   { autoApprove: true },
  );
  assert.equal(approve.status, 403);
 });

 assert.equal(db.state.tokenRotations, 0, 'a denied admin must not rotate the credential');
 assert.equal(db.state.autoApproveWrites, 0, 'a denied admin must not change registration authority');
});
