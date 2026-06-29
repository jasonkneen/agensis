// ============================================================================
// tests/backend-rbac.test.cjs
// ----------------------------------------------------------------------------
// Recommended Minimum Test Plan — ITEM 1: RBAC denials.
//
// Exercises the central authorization gate `enforceDbOperationAccess` in
// shared/backend-core.mjs DIRECTLY (no server, no live Postgres). A tiny mock
// `db(sql, params)` returns canned role/owner rows, mirroring the mocking style
// in tests/backend-auth.test.cjs.
//
// Covered denial surfaces:
//   - unauthenticated (no userId)                 -> 401
//   - authenticated but no workspace access       -> 403
//   - viewer attempting update / insert / delete  -> 403
//   - editor deleting a workspace (manage-only)   -> 403
//   - empty-filter update AND delete (wipe guard) -> 400  (normal table + workspaces)
//   - a valid editor write                        -> allowed (no throw)
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let core;
test.before(async () => {
  core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.mjs')).href);
});

function eq(column, value) {
  return { column, operator: 'eq', value };
}

// Mock db with the shape `db(sql, params) => Promise<rows[]>`, answering only
// the queries backend-core issues during authorization. Keyed config:
//   owners:        { [workspaceId]: ownerUserId }
//   roles:         { `${workspaceId}:${userId}`: role }
//   rowWorkspaces: { [table]: { [rowId]: workspaceId } }
function makeDb({ owners = {}, roles = {}, rowWorkspaces = {} } = {}) {
  const calls = [];
  async function db(sql, params = []) {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    calls.push({ sql, params });

    // getWorkspaceRole — owner check
    if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
      return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
    }
    // getWorkspaceRole — member role
    if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
      const role = roles[`${params[0]}:${params[1]}`];
      return role ? [{ role }] : [];
    }
    // resolveWorkspaceRowById
    if (n.startsWith('select id from workspaces where id = $1')) {
      return params[0] ? [{ id: params[0] }] : [];
    }
    // parent-row / id workspace resolution
    const m = n.match(/^select workspace_id from "?([a-z_]+)"? where id = \$1 limit 1/);
    if (m) {
      const ws = rowWorkspaces[m[1]]?.[params[0]];
      return ws ? [{ workspace_id: ws }] : [];
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  }
  db.calls = calls;
  return db;
}

test('unauthenticated request (no userId) is rejected 401', async () => {
  const db = makeDb({ roles: { 'ws-1:user-1': 'editor' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: null, table: 'tasks', op: 'select', filters: [eq('workspace_id', 'ws-1')], db,
    }),
    { status: 401 },
  );
});

test('authenticated user with no workspace access is rejected 403', async () => {
  const db = makeDb(); // no roles, no ownership
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-stranger', table: 'tasks', op: 'select', filters: [eq('workspace_id', 'ws-1')], db,
    }),
    { status: 403, message: 'You do not have access to this workspace' },
  );
});

test('viewer cannot update a workspace row', async () => {
  const db = makeDb({ roles: { 'ws-1:user-viewer': 'viewer' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-viewer', table: 'tasks', op: 'update', filters: [eq('workspace_id', 'ws-1')], db,
    }),
    { status: 403, message: 'You do not have permission to change this workspace' },
  );
});

test('viewer cannot insert a workspace row', async () => {
  const db = makeDb({ roles: { 'ws-1:user-viewer': 'viewer' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-viewer', table: 'documents', op: 'insert',
      payload: { values: { workspace_id: 'ws-1', title: 'nope' } }, db,
    }),
    { status: 403, message: 'You do not have permission to change this workspace' },
  );
});

test('viewer cannot delete a workspace row', async () => {
  const db = makeDb({ roles: { 'ws-1:user-viewer': 'viewer' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-viewer', table: 'tasks', op: 'delete', filters: [eq('workspace_id', 'ws-1')], db,
    }),
    { status: 403, message: 'You do not have permission to change this workspace' },
  );
});

test('editor cannot delete a workspace (manage-only operation)', async () => {
  const db = makeDb({ roles: { 'ws-1:user-editor': 'editor' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'workspaces', op: 'delete', filters: [eq('id', 'ws-1')], db,
    }),
    { status: 403, message: 'You do not have permission to manage this workspace' },
  );
});

test('empty-filter UPDATE is rejected 400 on a normal table (wipe guard)', async () => {
  const db = makeDb({ roles: { 'ws-1:user-editor': 'editor' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'tasks', op: 'update', filters: [], db,
    }),
    { status: 400, message: 'Update requires at least one filter' },
  );
});

test('empty-filter DELETE is rejected 400 on a normal table (wipe guard)', async () => {
  const db = makeDb({ roles: { 'ws-1:user-editor': 'editor' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'tasks', op: 'delete', filters: [], db,
    }),
    { status: 400, message: 'Delete requires at least one filter' },
  );
});

test('empty-filter UPDATE is rejected 400 on the workspaces table (wipe guard)', async () => {
  const db = makeDb({ owners: { 'ws-1': 'user-owner' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-owner', table: 'workspaces', op: 'update', filters: [], db,
    }),
    { status: 400, message: 'Update requires at least one filter' },
  );
});

test('empty-filter DELETE is rejected 400 on the workspaces table (wipe guard)', async () => {
  const db = makeDb({ owners: { 'ws-1': 'user-owner' } });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-owner', table: 'workspaces', op: 'delete', filters: [], db,
    }),
    { status: 400, message: 'Delete requires at least one filter' },
  );
});

test('a valid editor write is allowed (no throw)', async () => {
  const db = makeDb({ roles: { 'ws-1:user-editor': 'editor' } });
  await assert.doesNotReject(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'tasks', op: 'update', filters: [eq('workspace_id', 'ws-1')], db,
    }),
  );
  await assert.doesNotReject(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'documents', op: 'insert',
      payload: { values: { workspace_id: 'ws-1', title: 'ok' } }, db,
    }),
  );
});
