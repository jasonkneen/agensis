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
  core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.cjs')).href);
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

test('shared WORKSPACE_SCOPED_TABLES covers every multi-tenant ALLOWED table the server scopes', async () => {
  const server = require('../server/index.cjs');
  const serverScoped = server.__test.WORKSPACE_SCOPED_TABLES;
  const sharedScoped = core.WORKSPACE_SCOPED_TABLES;

  // Server imports the shared set — they must be the same reference-equal Set
  // or at least contain identical members.
  const serverList = [...serverScoped].sort();
  const sharedList = [...sharedScoped].sort();
  assert.deepEqual(sharedList, serverList);

  const required = [
    'agent_memory_files',
    'memory_file_comments',
    'thread_items',
    'agent_registrations',
    'cursorbuddy_connection_keys',
    'uploaded_files',
    'workspace_agents',
  ];
  for (const table of required) {
    assert.equal(sharedScoped.has(table), true, `missing scoped table: ${table}`);
  }

  // Every ALLOWED table that is multi-tenant (not app_users/workspaces/messages)
  // must be workspace-scoped. messages is special-cased in enforceDbOperationAccess.
  for (const table of core.ALLOWED_TABLES) {
    if (table === 'app_users' || table === 'workspaces' || table === 'messages') continue;
    assert.equal(
      sharedScoped.has(table),
      true,
      `ALLOWED table ${table} is not in WORKSPACE_SCOPED_TABLES (Netlify tenancy hole)`,
    );
  }
});

test('stripPrivilegedDbValues removes mcp_approved and storage_path from generic writes', () => {
  const agents = core.stripPrivilegedDbValues('workspace_agents', {
    name: 'Coder',
    mcp_approved: true,
    permission_mode: 'yolo',
    connect_token_hash: 'abc',
  });
  assert.equal(agents.name, 'Coder');
  assert.equal(Object.prototype.hasOwnProperty.call(agents, 'mcp_approved'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(agents, 'permission_mode'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(agents, 'connect_token_hash'), false);

  const files = core.stripPrivilegedDbValues('uploaded_files', {
    name: 'x.png',
    workspace_id: 'ws-1',
    storage_path: 'ws-other/secret.png',
    type: 'image/png',
    content_sha256: 'deadbeef',
  });
  assert.equal(files.name, 'x.png');
  assert.equal(files.workspace_id, 'ws-1');
  assert.equal(Object.prototype.hasOwnProperty.call(files, 'storage_path'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(files, 'type'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(files, 'content_sha256'), false);

  assert.equal(core.storagePathBelongsToWorkspace('ws-1', 'ws-1/id-file.png'), true);
  assert.equal(core.storagePathBelongsToWorkspace('ws-1', 'ws-2/id-file.png'), false);
  assert.equal(core.storagePathBelongsToWorkspace('ws-1', '../etc/passwd'), false);
  // Traversal that starts with the victim workspace prefix but escapes it.
  assert.equal(core.storagePathBelongsToWorkspace('ws-1', 'ws-1/../ws-2/secret.txt'), false);
  assert.equal(core.storagePathBelongsToWorkspace('ws-1', 'ws-1/foo/../../ws-2/x'), false);
  assert.equal(core.storagePathBelongsToWorkspace('ws-1', '/ws-1/file.png'), false);
  assert.equal(core.storagePathBelongsToWorkspace('ws-1', 'ws-1/./nested/file.png'), true);
});

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

// ---------------------------------------------------------------------------
// H1 (2026-07 review): cross-tenant row reassignment via UPDATE values.
// An editor of workspace A must not be able to move/inject a row into a
// workspace they have no role in by setting workspace_id (or a parent-ref
// column) in the update's `values`. The gate must authorize the SOURCE row's
// workspace AND reject any values that change tenancy across workspaces, while
// still allowing an in-workspace parent move (e.g. canvas object → another
// group in the same workspace).
// ---------------------------------------------------------------------------

test('H1: editor cannot move a row to another workspace via values.workspace_id', async () => {
  const db = makeDb({
    roles: { 'ws-1:user-editor': 'editor' },
    rowWorkspaces: { tasks: { 'task-1': 'ws-1' } },
  });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'tasks', op: 'update',
      filters: [eq('id', 'task-1')],
      payload: { values: { workspace_id: 'ws-2', title: 'stolen' } }, db,
    }),
    { status: 403 },
  );
});

test('H1: editor cannot reassign a child row under another workspace parent (group_id)', async () => {
  const db = makeDb({
    roles: { 'ws-1:user-editor': 'editor' },
    rowWorkspaces: { canvas_objects: { 'obj-1': 'ws-1' }, canvas_groups: { 'grp-2': 'ws-2' } },
  });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'canvas_objects', op: 'update',
      filters: [eq('id', 'obj-1')],
      payload: { values: { group_id: 'grp-2' } }, db,
    }),
    { status: 403 },
  );
});

test('H1: editor cannot move a message under another workspace session (session_id)', async () => {
  const db = makeDb({
    roles: { 'ws-1:user-editor': 'editor' },
    rowWorkspaces: { chat_sessions: { 'sess-1': 'ws-1', 'sess-2': 'ws-2' } },
  });
  await assert.rejects(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'messages', op: 'update',
      filters: [eq('session_id', 'sess-1')],
      payload: { values: { session_id: 'sess-2' } }, db,
    }),
    { status: 403 },
  );
});

test('H1: editor CAN move a canvas object to another group in the SAME workspace', async () => {
  const db = makeDb({
    roles: { 'ws-1:user-editor': 'editor' },
    rowWorkspaces: { canvas_objects: { 'obj-1': 'ws-1' }, canvas_groups: { 'grp-1': 'ws-1' } },
  });
  await assert.doesNotReject(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'canvas_objects', op: 'update',
      filters: [eq('id', 'obj-1')],
      payload: { values: { group_id: 'grp-1' } }, db,
    }),
  );
});

test('H1: clearing group_id (null) on an in-workspace row is allowed', async () => {
  const db = makeDb({
    roles: { 'ws-1:user-editor': 'editor' },
    rowWorkspaces: { canvas_objects: { 'obj-1': 'ws-1' } },
  });
  await assert.doesNotReject(
    () => core.enforceDbOperationAccess({
      userId: 'user-editor', table: 'canvas_objects', op: 'update',
      filters: [eq('id', 'obj-1')],
      payload: { values: { group_id: null } }, db,
    }),
  );
});
