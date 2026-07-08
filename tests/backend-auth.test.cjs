const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { createApp, __test } = require('../server/index.cjs');

function eq(column, value) {
  return { column, operator: 'eq', value };
}

// In-memory app_users table — supports both the signup/signin/change-password
// routes (plan 004, keyed by email) and token_version-revocation tests (plan
// 005, keyed by userId with a lazy '1' default so every pre-existing
// `__test.issueToken(id, '1')` call in the RBAC/settings tests above keeps
// working without seeding a row). Both `appUsers` (email -> partial record)
// and `users` (id -> partial record) seed the SAME underlying store, since
// every authenticated request now round-trips through token_version
// (verifyToken), not just the auth-specific routes.
function makeDb({ owners = {}, roles = {}, rowWorkspaces = {}, workspaceSecrets = {}, appSettings = {}, authSecret = 'test-secret', appUsers = {}, users = {} } = {}) {
  const secretRows = { ...workspaceSecrets };
  const settingRows = { ...appSettings };
  if (authSecret) settingRows.AUTH_SECRET = authSecret;

  const userRows = {}; // id -> { id, email, password_hash, display_name, accent_color, created_at, token_version }
  const userIdByEmail = new Map();
  let nextUserId = 1;
  for (const [email, record] of Object.entries(appUsers)) {
    const id = record.id || `user-${nextUserId++}`;
    userRows[id] = {
      id,
      email,
      password_hash: record.password_hash || '',
      display_name: record.display_name || '',
      accent_color: record.accent_color || '',
      created_at: record.created_at || new Date().toISOString(),
      token_version: String(record.token_version ?? 1),
    };
    userIdByEmail.set(email, id);
  }
  for (const [id, config] of Object.entries(users)) {
    const existing = userRows[id];
    userRows[id] = {
      id,
      email: existing?.email || config.email || '',
      password_hash: config.password_hash ?? existing?.password_hash ?? null,
      display_name: existing?.display_name || '',
      accent_color: existing?.accent_color || '',
      created_at: existing?.created_at || new Date().toISOString(),
      token_version: String(config.token_version ?? existing?.token_version ?? 1),
    };
    if (userRows[id].email) userIdByEmail.set(userRows[id].email, id);
  }
  function getUserRow(id) {
    if (!userRows[id]) {
      userRows[id] = { id, email: '', password_hash: null, display_name: '', accent_color: '', created_at: new Date().toISOString(), token_version: '1' };
    }
    return userRows[id];
  }

  return {
    calls: [],
    userRows, // exposed so a test can bump/mutate token_version "out of band" (bypassing the app) to test cache staleness
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

      if (normalized.startsWith('select id from app_users where email = $1 limit 1')) {
        const id = userIdByEmail.get(params[0]);
        return id ? [{ id }] : [];
      }

      if (normalized.startsWith('insert into app_users (email, password_hash) values')) {
        const id = `user-${nextUserId++}`;
        const user = {
          id,
          email: params[0],
          password_hash: params[1],
          display_name: '',
          accent_color: '',
          created_at: new Date().toISOString(),
          token_version: '1',
        };
        userRows[id] = user;
        userIdByEmail.set(params[0], id);
        return [{ id: user.id, email: user.email, display_name: user.display_name, accent_color: user.accent_color, created_at: user.created_at, token_version: user.token_version }];
      }

      if (normalized.startsWith('select id, email, password_hash, display_name, accent_color, created_at, token_version from app_users where email = $1 limit 1')) {
        const id = userIdByEmail.get(params[0]);
        const user = id ? userRows[id] : null;
        return user ? [user] : [];
      }

      if (normalized.startsWith('select token_version from app_users where id = $1')) {
        return [{ token_version: getUserRow(params[0]).token_version }];
      }

      if (normalized.startsWith('select id, password_hash from app_users where id = $1')) {
        const row = getUserRow(params[0]);
        return row.password_hash ? [{ id: params[0], password_hash: row.password_hash }] : [];
      }

      if (normalized.startsWith('update app_users set password_hash = $2, token_version = token_version + 1 where id = $1')) {
        const row = getUserRow(params[0]);
        row.password_hash = params[1];
        row.token_version = String(Number(row.token_version) + 1);
        return [{ token_version: row.token_version }];
      }

      if (normalized.startsWith('update app_users set token_version = token_version + 1 where id = $1')) {
        const row = getUserRow(params[0]);
        row.token_version = String(Number(row.token_version) + 1);
        return [{ token_version: row.token_version }];
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
  installDb({ roles: { 'ws-1:user-commenter': 'commenter' }, rowWorkspaces: { documents: { 'doc-1': 'ws-1' } } });

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

  const token = await __test.issueToken('user-1', '1');
  assert.equal(await __test.verifyToken(token), 'user-1');
  assert.equal(await __test.verifyToken(`${token}tampered`), null);
});

test('AUTH_SECRET env var takes precedence over the DB-persisted secret', async () => {
  // DB carries one secret; env carries another. Env must win so a token signed
  // by the Netlify function (env) verifies on the Fly backend (env) even when a
  // stale/random DB secret exists from a prior local-dev run.
  installDb({ authSecret: 'db-fallback-secret' });
  const prev = process.env.AUTH_SECRET;
  try {
    process.env.AUTH_SECRET = 'env-shared-secret';
    __test.resetTestState();
    installDb({ authSecret: 'db-fallback-secret' });

    const token = await __test.issueToken('user-1', '1');
    assert.equal(await __test.verifyToken(token), 'user-1');
    // A token signed with the DB secret must NOT verify once env is authoritative.
    const dbPayload = 'user-1.1';
    const dbSig = require('crypto').createHmac('sha256', 'db-fallback-secret').update(dbPayload).digest('base64url');
    assert.equal(await __test.verifyToken(`${dbPayload}.${dbSig}`), null);
  } finally {
    if (prev === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prev;
    __test.resetTestState();
  }
});

test('AGENSIS_AUTH_SECRET env var is preferred over AUTH_SECRET', async () => {
  installDb({ authSecret: 'db-fallback-secret' });
  const prevA = process.env.AGENSIS_AUTH_SECRET;
  const prevB = process.env.AUTH_SECRET;
  try {
    process.env.AGENSIS_AUTH_SECRET = 'agensis-pref';
    process.env.AUTH_SECRET = 'plain-auth';
    __test.resetTestState();
    installDb({ authSecret: 'db-fallback-secret' });

    const token = await __test.issueToken('user-1', '1');
    const expectedSig = require('crypto').createHmac('sha256', 'agensis-pref').update('user-1.1').digest('base64url');
    assert.equal(token, `user-1.1.${expectedSig}`);
    assert.equal(await __test.verifyToken(token), 'user-1');
  } finally {
    if (prevA === undefined) delete process.env.AGENSIS_AUTH_SECRET;
    else process.env.AGENSIS_AUTH_SECRET = prevA;
    if (prevB === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = prevB;
    __test.resetTestState();
  }
});

test('falls back to DB-persisted secret when no env secret is configured', async () => {
  installDb({ authSecret: 'db-only-secret' });
  const prevA = process.env.AGENSIS_AUTH_SECRET;
  const prevB = process.env.AUTH_SECRET;
  try {
    delete process.env.AGENSIS_AUTH_SECRET;
    delete process.env.AUTH_SECRET;
    __test.resetTestState();
    installDb({ authSecret: 'db-only-secret' });

    const token = await __test.issueToken('user-1', '1');
    assert.equal(await __test.verifyToken(token), 'user-1');
  } finally {
    if (prevA !== undefined) process.env.AGENSIS_AUTH_SECRET = prevA;
    if (prevB !== undefined) process.env.AUTH_SECRET = prevB;
    __test.resetTestState();
  }
});

test('settings secrets route requires authentication and supports app-level secrets', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/backend/settings/secrets?workspaceId=ws-1`);
    assert.equal(unauthenticated.status, 401);

    const token = await __test.issueToken('user-1', '1');
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
    const editorToken = await __test.issueToken('user-editor', '1');
    const editorResponse = await authedFetch(baseUrl, editorToken, '/backend/settings/secrets?workspaceId=ws-1');
    assert.equal(editorResponse.status, 403);

    const adminToken = await __test.issueToken('user-admin', '1');
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
    const token = await __test.issueToken('user-admin', '1');
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

test('settings secrets POST rejects app-level writes for ordinary authenticated users', async () => {
  const fakeDb = installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');

    const noWorkspace = await authedFetch(baseUrl, token, '/backend/settings/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ANTHROPIC_API_KEY: 'sk-evil-platform-key' }),
    });
    const noWorkspaceBody = await noWorkspace.json();
    assert.equal(noWorkspace.status, 403);
    assert.match(noWorkspaceBody.error.message, /App-level secret management/i);
    assert.equal(
      fakeDb.calls.some(call => String(call.sql).includes('insert into app_settings')),
      false,
    );

    const baseWorkspace = await authedFetch(baseUrl, token, '/backend/settings/secrets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId: 'base', ANTHROPIC_API_KEY: '' }),
    });
    assert.equal(baseWorkspace.status, 403);
    assert.equal(
      fakeDb.calls.some(call => String(call.sql).includes('insert into app_settings')),
      false,
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
    const editorToken = await __test.issueToken('user-editor', '1');
    const missingWorkspace = await authedFetch(baseUrl, editorToken, '/backend/ai-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(missingWorkspace.status, 400);

    const commenterToken = await __test.issueToken('user-commenter', '1');
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

test('ai-chat normalizes OpenAI-style system messages before provider dispatch', () => {
  const chat = __test.normalizeAiChatMessages([
    { role: 'system', content: 'Use CursorBuddy page context.' },
    { role: 'user', content: 'Help me here.' },
    { role: 'assistant', content: 'Sure.' },
    { role: 'tool', content: 'ignored role becomes user text' },
  ]);

  assert.deepEqual(chat.messages, [
    { role: 'user', content: 'Help me here.' },
    { role: 'assistant', content: 'Sure.' },
    { role: 'user', content: 'ignored role becomes user text' },
  ]);
  assert.equal(chat.systemPrompt, 'Use CursorBuddy page context.');
  assert.equal(chat.messages.some((message) => message.role === 'system'), false);

  const system = __test.buildSystemPrompt('', '', null, {
    name: 'CursorBuddy Provider',
    systemPrompt: chat.systemPrompt,
  });
  assert.match(system, /CursorBuddy Provider/);
  assert.match(system, /Use CursorBuddy page context\./);
});

// ----------------------------------------------------------------------------
// Plan 004 — server-side auth hardening (password policy + rate limiting).
// ----------------------------------------------------------------------------

test('evaluatePasswordServerSide enforces length + character-class-count policy', () => {
  const weakShort = __test.evaluatePasswordServerSide('abc123');
  assert.equal(weakShort.valid, false);

  const weakSingleClass = __test.evaluatePasswordServerSide('abcdefgh');
  assert.equal(weakSingleClass.valid, false);
  assert.equal(weakSingleClass.classesMet, 1);

  const compliant = __test.evaluatePasswordServerSide('Tr0ub4dor&3xyz');
  assert.equal(compliant.valid, true);
});

test('POST /backend/auth/signup rejects a weak, single-character-class password', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/backend/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'weak-signup@example.com', password: 'abcdefgh' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error.message, /character|characters/i);
  });
});

test('POST /backend/auth/signup still succeeds for a policy-compliant password (no regression)', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/backend/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'compliant-signup@example.com', password: 'Tr0ub4dor&3xyz' }),
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.data.user.email, 'compliant-signup@example.com');
    assert.ok(body.data.token);
  });
});

test('POST /backend/users/me/change-password rejects a weak newPassword', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    // Create a real account first so currentPassword actually matches — the
    // weak-newPassword rejection must fire on its own merit, not because the
    // current-password check happened to fail first.
    const signup = await fetch(`${baseUrl}/backend/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'change-pw@example.com', password: 'Tr0ub4dor&3xyz' }),
    });
    const { data } = await signup.json();

    const response = await authedFetch(baseUrl, data.token, '/backend/users/me/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Tr0ub4dor&3xyz', newPassword: 'abc123' }),
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.match(body.error.message, /character|characters/i);
  });
});

test('POST /backend/auth/signin rate-limits repeated failed attempts for the same email (429 on the 6th)', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const email = 'rate-limited-signin@example.com'; // unique to this test — limiter state is module-scoped
    const attempt = () => fetch(`${baseUrl}/backend/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'whatever-wrong' }),
    });

    for (let i = 0; i < 5; i += 1) {
      const response = await attempt();
      assert.equal(response.status, 401, `attempt ${i + 1} should be a normal auth failure, not rate-limited`);
    }

    const sixth = await attempt();
    assert.equal(sixth.status, 429);
    assert.ok(sixth.headers.get('retry-after'));
  });
});

test('POST /backend/auth/signin: a correct password is never locked out by prior failed attempts (L3)', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const email = 'lockout-victim@example.com'; // unique so its per-email budget starts fresh
    const password = 'Tr0ub4dor&3xyz';
    const signup = await fetch(`${baseUrl}/backend/auth/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(signup.status, 200);

    // An attacker exhausts the email's failed-attempt budget with wrong passwords.
    for (let i = 0; i < 6; i += 1) {
      await fetch(`${baseUrl}/backend/auth/signin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'definitely-wrong' }),
      });
    }

    // The real user must still sign in with the correct password — no lockout.
    const ok = await fetch(`${baseUrl}/backend/auth/signin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    assert.equal(ok.status, 200, 'correct password must succeed despite prior failed attempts');
    const body = await ok.json();
    assert.ok(body.data?.token, 'issues a token');
  });
});

// ============================================================================
// Plan 005 — token expiry and revocation.
//
// The token now embeds a `token_version` that must match the user's current
// app_users.token_version. Bumping that counter (sign-out, password change)
// invalidates every outstanding token for that user in one shot.
// ============================================================================

// Mirrors server/index.cjs's createPasswordHash format (`${salt}:${hash}`,
// scrypt keylen 64) without needing to export it — lets a test seed a row with
// a password that /backend/users/me/change-password can actually verify.
function testPasswordHash(password) {
  const salt = 'test-salt';
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

test('a token issued before a password change is rejected after the change; the returned fresh token keeps working', async () => {
  const fakeDb = installDb({
    authSecret: 'fixed-test-secret',
    users: { 'user-1': { password_hash: testPasswordHash('correct horse battery staple'), token_version: 1 } },
  });

  await withServer(async (baseUrl) => {
    const oldToken = await __test.issueToken('user-1', '1');

    const before = await authedFetch(baseUrl, oldToken, '/backend/settings/secrets');
    assert.equal(before.status, 200);

    const changeResponse = await authedFetch(baseUrl, oldToken, '/backend/users/me/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'correct horse battery staple', newPassword: 'new-password-123' }),
    });
    assert.equal(changeResponse.status, 200);
    const changeBody = await changeResponse.json();
    assert.equal(changeBody.data.ok, true);
    const freshToken = changeBody.data.token;
    assert.ok(freshToken, 'expected change-password to return a fresh token');

    // The token used BEFORE the change (still the same physical string used to
    // make the change-password call itself) must now be rejected.
    const afterOldToken = await authedFetch(baseUrl, oldToken, '/backend/settings/secrets');
    assert.equal(afterOldToken.status, 401);

    // The fresh token returned in the response keeps the session alive (no
    // forced re-login) even though it embeds the bumped version.
    const afterFreshToken = await authedFetch(baseUrl, freshToken, '/backend/settings/secrets');
    assert.equal(afterFreshToken.status, 200);

    assert.equal(fakeDb.userRows['user-1'].token_version, '2');
  });
});

test('POST /backend/auth/signout requires auth and invalidates the calling token immediately', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  await withServer(async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/backend/auth/signout`, { method: 'POST' });
    assert.equal(unauthenticated.status, 401);

    const token = await __test.issueToken('user-1', '1');
    const before = await authedFetch(baseUrl, token, '/backend/settings/secrets');
    assert.equal(before.status, 200);

    const signOutResponse = await authedFetch(baseUrl, token, '/backend/auth/signout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(signOutResponse.status, 200);
    const signOutBody = await signOutResponse.json();
    assert.equal(signOutBody.data.ok, true);

    // Reusing the same token right after sign-out must fail immediately — this
    // instance just wrote the bump itself, so there is no 10s cache window here
    // (that window only applies to OTHER instances in a multi-instance deploy).
    const afterSignOut = await authedFetch(baseUrl, token, '/backend/settings/secrets');
    assert.equal(afterSignOut.status, 401);

    // A fresh sign-in (a newly issued token for the bumped version) works again.
    const freshToken = await __test.issueToken('user-1', '2');
    const afterFresh = await authedFetch(baseUrl, freshToken, '/backend/settings/secrets');
    assert.equal(afterFresh.status, 200);
  });
});

test('a token with a tampered tokenVersion segment (validly re-signed for that tampered payload) is rejected', async () => {
  installDb({ authSecret: 'fixed-test-secret' });

  // Simulates an attacker who holds a captured token and tries to forge a
  // different version, correctly re-signing the (now different) payload with
  // the same secret. Signature verification alone can't catch this — only the
  // DB's actual CURRENT token_version can, which is what this asserts.
  const forgedPayload = 'user-1.999';
  const forgedSig = crypto.createHmac('sha256', 'fixed-test-secret').update(forgedPayload).digest('base64url');
  const forgedToken = `${forgedPayload}.${forgedSig}`;

  assert.equal(await __test.verifyToken(forgedToken), null);
});

test('tokenVersionCache actually caches: serves a stale version within its TTL, then refreshes after it expires', async () => {
  const fakeDb = installDb({ authSecret: 'fixed-test-secret', users: { 'user-1': { token_version: 1 } } });
  mock.timers.enable({ apis: ['Date'] });
  try {
    const token = await __test.issueToken('user-1', '1');
    // Populates the cache with version '1'.
    assert.equal(await __test.verifyToken(token), 'user-1');

    // Bump token_version directly in the fake DB's storage, bypassing the app —
    // simulates an out-of-band change (e.g. another process revoking the user).
    fakeDb.userRows['user-1'].token_version = '2';

    // Still within the TTL: the cache serves the OLD, now-stale version, so the
    // OLD token still authenticates — proves the cache is real, not a no-op.
    mock.timers.tick(__test.TOKEN_VERSION_CACHE_TTL_MS - 1000);
    assert.equal(await __test.verifyToken(token), 'user-1');

    // Past the TTL: the cache entry has expired, verifyToken re-reads the DB and
    // picks up the bumped version — the old token is now rejected.
    mock.timers.tick(2000);
    assert.equal(await __test.verifyToken(token), null);
  } finally {
    mock.timers.reset();
  }
});
