const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

function eq(column, value) {
  return { column, operator: 'eq', value };
}

function makeDb({ owners = {}, roles = {}, rowWorkspaces = {}, workspaceSecrets = {}, appSettings = {}, authSecret = 'test-secret' } = {}) {
  const secretRows = { ...workspaceSecrets };
  const settingRows = { ...appSettings };
  if (authSecret) settingRows.AUTH_SECRET = authSecret;
  return {
    calls: [],
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      this.calls.push({ sql, params });

      if (
        normalized.startsWith('alter table') ||
        normalized.startsWith('create table') ||
        normalized.startsWith('create index') ||
        normalized.startsWith('do $$')
      ) {
        return [];
      }

      if (normalized.startsWith('select value from app_settings')) {
        const value = settingRows[params[0]];
        return value ? [{ value }] : [];
      }

      if (normalized.startsWith('insert into app_settings')) {
        settingRows[params[0]] = params[1];
        return [];
      }

      if (normalized.startsWith('select value from workspace_secrets where workspace_id = $1 and key = $2')) {
        const value = secretRows[`${params[0]}:${params[1]}`];
        return value ? [{ value }] : [];
      }

      if (normalized.startsWith('insert into workspace_secrets')) {
        secretRows[`${params[0]}:${params[1]}`] = params[2];
        return [];
      }

      if (normalized.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }

      if (normalized.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }

      if (normalized.startsWith('select id from workspaces where id = $1')) {
        return params[0] ? [{ id: params[0] }] : [];
      }

      const workspaceLookup = normalized.match(/^select workspace_id from "?([a-z_]+)"? where id = \$1 limit 1/);
      if (workspaceLookup) {
        const table = workspaceLookup[1];
        const workspaceId = rowWorkspaces[table]?.[params[0]];
        return workspaceId ? [{ workspace_id: workspaceId }] : [];
      }

      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

function installDb(config) {
  const fakeDb = makeDb(config);
  __test.setTestDb(fakeDb);
  return fakeDb;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function authedFetch(baseUrl, token, path, init = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init.headers || {}),
      Authorization: `Bearer ${token}`,
    },
  });
}

test.beforeEach(() => {
  __test.resetTestState();
});

test.afterEach(() => {
  __test.resetTestState();
});

test('workspace roles expose the expected coarse capabilities', () => {
  assert.equal(__test.roleHasWorkspaceCapability('owner', 'manage'), true);
  assert.equal(__test.roleHasWorkspaceCapability('admin', 'manage'), true);
  assert.equal(__test.roleHasWorkspaceCapability('editor', 'write'), true);
  assert.equal(__test.roleHasWorkspaceCapability('editor', 'manage'), false);
  assert.equal(__test.roleHasWorkspaceCapability('commenter', 'comment'), true);
  assert.equal(__test.roleHasWorkspaceCapability('commenter', 'write'), false);
  assert.equal(__test.roleHasWorkspaceCapability('viewer', 'read'), true);
  assert.equal(__test.roleHasWorkspaceCapability('viewer', 'comment'), false);
});

test('generic DB policy lets viewers read workspace rows but blocks mutations', async () => {
  installDb({ roles: { 'ws-1:user-viewer': 'viewer' } });

  await __test.enforceDbOperationAccess('user-viewer', 'documents', 'select', {
    filters: [eq('workspace_id', 'ws-1')],
  });

  await assert.rejects(
    () => __test.enforceDbOperationAccess('user-viewer', 'documents', 'update', {
      filters: [eq('workspace_id', 'ws-1')],
    }),
    { status: 403, message: 'You do not have permission to change this workspace' },
  );
});

test('commenters can write comments but not edit documents', async () => {
  installDb({ roles: { 'ws-1:user-commenter': 'commenter' } });

  await __test.enforceDbOperationAccess('user-commenter', 'document_comments', 'insert', {
    values: { workspace_id: 'ws-1', document_id: 'doc-1', content: 'Looks good' },
  });

  await assert.rejects(
    () => __test.enforceDbOperationAccess('user-commenter', 'documents', 'update', {
      filters: [eq('workspace_id', 'ws-1')],
    }),
    { status: 403, message: 'You do not have permission to change this workspace' },
  );
});

test('editors can update content but cannot manage membership or webhook tokens', async () => {
  installDb({ roles: { 'ws-1:user-editor': 'editor' } });

  await __test.enforceDbOperationAccess('user-editor', 'tasks', 'update', {
    filters: [eq('workspace_id', 'ws-1')],
  });

  await assert.rejects(
    () => __test.enforceDbOperationAccess('user-editor', 'workspace_members', 'insert', {
      values: { workspace_id: 'ws-1', user_id: 'other-user', role: 'viewer' },
    }),
    { status: 403, message: 'You do not have permission to manage this workspace' },
  );

  await assert.rejects(
    () => __test.enforceDbOperationAccess('user-editor', 'agent_webhooks', 'select', {
      filters: [eq('workspace_id', 'ws-1')],
    }),
    { status: 403, message: 'You do not have permission to manage this workspace' },
  );
});

test('owners can manage workspace members and webhook entries', async () => {
  installDb({ owners: { 'ws-1': 'user-owner' } });

  await __test.enforceDbOperationAccess('user-owner', 'workspace_members', 'insert', {
    values: { workspace_id: 'ws-1', user_id: 'other-user', role: 'viewer' },
  });

  await __test.enforceDbOperationAccess('user-owner', 'agent_webhooks', 'select', {
    filters: [eq('workspace_id', 'ws-1')],
  });
});

test('workspace-scoped operations require a workspace filter or resolvable parent row', async () => {
  installDb({
    roles: { 'ws-1:user-editor': 'editor' },
    rowWorkspaces: { chat_sessions: { 'session-1': 'ws-1' } },
  });

  await assert.rejects(
    () => __test.enforceDbOperationAccess('user-editor', 'tasks', 'select', { filters: [] }),
    { status: 400, message: 'A workspace filter is required for this operation' },
  );

  await __test.enforceDbOperationAccess('user-editor', 'messages', 'insert', {
    values: { session_id: 'session-1', role: 'user', content: 'hello' },
  });
});

test('direct app_users table access is limited to the current user row', async () => {
  installDb();

  await __test.enforceDbOperationAccess('user-1', 'app_users', 'select', {
    filters: [eq('id', 'user-1')],
  });

  await assert.rejects(
    () => __test.enforceDbOperationAccess('user-1', 'app_users', 'select', {
      filters: [eq('id', 'user-2')],
    }),
    { status: 403, message: 'Direct user table access is not allowed' },
  );
});

test('workspace selects add owner/member access predicates', () => {
  const where = __test.appendWorkspaceAccessClause(__test.buildWhereClause([eq('id', 'ws-1')], []), 'user-1');

  assert.match(where.clause, /"workspaces"\."user_id" = \$2/);
  assert.match(where.clause, /workspace_members/);
  assert.deepEqual(where.params, ['ws-1', 'user-1', 'user-1']);
});

test('realtime broadcast channels require a valid workspace channel and membership', async () => {
  installDb({ roles: { 'ws-1:user-viewer': 'viewer' } });

  await __test.authorizeRealtimeBinding('user-viewer', 'cursors:ws-1', {
    type: 'broadcast',
    event: 'cursor_move',
  });

  await assert.rejects(
    () => __test.authorizeRealtimeBroadcast('user-viewer', 'global'),
    { status: 403, message: 'Broadcast channel is not allowed' },
  );
});

test('realtime db subscriptions must be workspace scoped', async () => {
  installDb({ roles: { 'ws-1:user-viewer': 'viewer' } });

  await __test.authorizeRealtimeBinding('user-viewer', 'activity:ws-1', {
    type: 'db_changes',
    table: 'tasks',
    filter: 'workspace_id=eq.ws-1',
  });

  await assert.rejects(
    () => __test.authorizeRealtimeBinding('user-viewer', 'activity:ws-1', {
      type: 'db_changes',
      table: 'tasks',
    }),
    { status: 400, message: 'A workspace filter is required for this operation' },
  );
});

test('realtime workspace table subscriptions require own user or readable workspace filters', async () => {
  installDb({ roles: { 'ws-1:user-viewer': 'viewer' } });

  await __test.authorizeRealtimeBinding('user-viewer', 'workspaces:user-viewer', {
    type: 'db_changes',
    table: 'workspaces',
    filter: 'user_id=eq.user-viewer',
  });

  await __test.authorizeRealtimeBinding('user-viewer', 'workspaces:ws-1', {
    type: 'db_changes',
    table: 'workspaces',
    filter: 'id=eq.ws-1',
  });

  await assert.rejects(
    () => __test.authorizeRealtimeBinding('user-viewer', 'workspaces:user-other', {
      type: 'db_changes',
      table: 'workspaces',
      filter: 'user_id=eq.user-other',
    }),
    { status: 403, message: 'Workspace realtime filter is not allowed' },
  );
});

test('issued auth tokens verify against the persisted auth secret', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  const token = await __test.issueToken('user-1');
  assert.equal(await __test.verifyToken(token), 'user-1');
  assert.equal(await __test.verifyToken(`${token}tampered`), null);
});

test('settings secrets route requires authentication and supports app-level secrets', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/backend/settings/secrets?workspaceId=ws-1`);
    assert.equal(unauthenticated.status, 401);

    const token = await __test.issueToken('user-1');
    const appLevel = await authedFetch(baseUrl, token, '/backend/settings/secrets');
    const body = await appLevel.json();
    assert.equal(appLevel.status, 200);
    assert.equal(Array.isArray(body.data.keys), true);
    assert.equal(body.data.keys[0].key, 'ANTHROPIC_API_KEY');
  });
});

test('settings secrets route is owner/admin only', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: {
      'ws-1:user-editor': 'editor',
      'ws-1:user-admin': 'admin',
    },
    workspaceSecrets: {
      'ws-1:ANTHROPIC_API_KEY': 'sk-workspace-secret',
    },
  });

  await withServer(async (baseUrl) => {
    const editorToken = await __test.issueToken('user-editor');
    const editorResponse = await authedFetch(baseUrl, editorToken, '/backend/settings/secrets?workspaceId=ws-1');
    assert.equal(editorResponse.status, 403);

    const adminToken = await __test.issueToken('user-admin');
    const adminResponse = await authedFetch(baseUrl, adminToken, '/backend/settings/secrets?workspaceId=ws-1');
    const adminBody = await adminResponse.json();
    assert.equal(adminResponse.status, 200);
    assert.equal(adminBody.data.keys[0].configured, true);
    assert.equal(adminBody.data.keys[0].scope, 'workspace');
    assert.match(adminBody.data.keys[0].preview, /^sk-w/);
  });
});

test('settings secrets post stores workspace-scoped values for admins', async () => {
  const fakeDb = installDb({
    authSecret: 'fixed-test-secret',
    roles: { 'ws-1:user-admin': 'admin' },
  });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-admin');
    const response = await authedFetch(baseUrl, token, '/backend/settings/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', ANTHROPIC_API_KEY: 'sk-new-workspace-key' }),
    });
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.data.keys[0].scope, 'workspace');
    assert.ok(fakeDb.calls.some(call => String(call.sql).includes('insert into workspace_secrets')));
    assert.equal(
      fakeDb.calls.some(call => call.params?.[0] === 'ws-1' && call.params?.[1] === 'ANTHROPIC_API_KEY' && call.params?.[2] === 'sk-new-workspace-key'),
      true,
    );
  });
});

test('ai-chat requires workspace id and run_agents capability before using AI key', async () => {
  installDb({
    authSecret: 'fixed-test-secret',
    roles: {
      'ws-1:user-commenter': 'commenter',
      'ws-1:user-editor': 'editor',
    },
  });

  await withServer(async (baseUrl) => {
    const editorToken = await __test.issueToken('user-editor');
    const missingWorkspace = await authedFetch(baseUrl, editorToken, '/backend/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(missingWorkspace.status, 400);

    const commenterToken = await __test.issueToken('user-commenter');
    const denied = await authedFetch(baseUrl, commenterToken, '/backend/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'ws-1', messages: [] }),
    });
    const deniedBody = await denied.json();
    assert.equal(denied.status, 403);
    assert.equal(deniedBody.error.message, 'You do not have permission to run agents in this workspace');
  });
});
