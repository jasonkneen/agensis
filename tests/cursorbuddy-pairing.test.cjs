const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

function makeDb() {
  const keys = [];
  const agents = [];
  const calls = [];
  return {
    calls,
    agents,
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql, normalized, params });
      if (
        normalized.startsWith('alter table') ||
        normalized.startsWith('create table') ||
        normalized.startsWith('create index') ||
        normalized.startsWith('do $$')
      ) return [];
      if (normalized.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'cursorbuddy-test-secret' }] : [];
      }
      if (normalized.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (normalized.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return params[0] === 'ws-1' && params[1] === 'user-1' ? [{ '?column?': 1 }] : [];
      }
      if (normalized.startsWith('select role from workspace_members')) return [];
      if (normalized.includes('from workspaces w left join workspace_members')) {
        return [{
          id: 'ws-1',
          name: 'CursorBuddy Workspace',
          description: '',
          local_path: '/Users/jkneen/Documents/GitHub/3Dpet',
          project_kind: 'web',
          git_root: '/Users/jkneen/Documents/GitHub/3Dpet',
          git_remote: 'git@example.com:cursorbuddy.git',
          role: 'owner',
          created_at: null,
          updated_at: null,
        }];
      }
      if (normalized.startsWith('select w.id from workspaces w left join workspace_members')) {
        return [{ id: 'ws-1' }];
      }
      if (normalized.startsWith('insert into cursorbuddy_connection_keys')) {
        const [workspaceId, agentId, createdBy, keyHash, name, surface, scope, domain, metadata] = params;
        const row = {
          id: `key-${keys.length + 1}`,
          workspace_id: workspaceId,
          agent_id: agentId,
          created_by: createdBy,
          key_hash: keyHash,
          name,
          surface,
          scope,
          domain,
          status: 'created',
          metadata,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          claimed_at: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        keys.push(row);
        return [row];
      }
      if (normalized.startsWith('select * from cursorbuddy_connection_keys where key_hash')) {
        return keys.filter((row) => row.key_hash === params[0]);
      }
      if (normalized.startsWith('select * from workspace_agents where id = $1 and workspace_id')) {
        return agents.filter((row) => row.id === params[0] && row.workspace_id === params[1]);
      }
      if (normalized.startsWith('select * from workspace_agents where workspace_id = $1 and handle = $2')) {
        return agents.filter((row) => row.workspace_id === params[0] && row.handle === params[1]);
      }
      if (normalized.startsWith('select id, workspace_id, name') && normalized.includes('from workspace_agents')) {
        return agents.filter((row) => row.workspace_id === params[0]);
      }
      if (normalized.startsWith('insert into workspace_agents')) {
        const [workspaceId, name, handle, description, systemPrompt] = params;
        const runMode = normalized.includes("'builtin'") ? 'builtin' : 'daemon';
        const permissionMode = runMode === 'builtin' ? 'default' : params[5];
        const createdBy = runMode === 'builtin' ? params[5] : params[6];
        const tools = runMode === 'builtin' ? params[6] : params[7];
        const skills = runMode === 'builtin' ? params[7] : params[8];
        const metadata = runMode === 'builtin' ? params[8] : params[9];
        const row = {
          id: `agent-${agents.length + 1}`,
          workspace_id: workspaceId,
          name,
          handle,
          description,
          system_prompt: systemPrompt,
          model: 'auto',
          permission_mode: permissionMode,
          created_by: createdBy,
          tools,
          skills,
          metadata,
          run_mode: runMode,
          enabled: true,
        };
        agents.push(row);
        return [row];
      }
      if (normalized.startsWith('select * from workspace_agents where id = $1 limit 1')) {
        return agents.filter((row) => row.id === params[0]);
      }
      if (normalized.startsWith('update workspace_agents set name = coalesce')) {
        const [id, label, description, systemPrompt, tools, skills, metadata] = params;
        const row = agents.find((agent) => agent.id === id);
        if (!row) return [];
        Object.assign(row, {
          name: row.name || label,
          description,
          system_prompt: systemPrompt,
          model: 'auto',
          run_mode: 'builtin',
          permission_mode: 'default',
          enabled: true,
          tools,
          skills,
          metadata,
        });
        return [row];
      }
      if (normalized.startsWith('update workspace_agents set handle = $2')) {
        const [id, handle, connectTokenHash, model, permissionMode] = params;
        const row = agents.find((agent) => agent.id === id);
        if (!row) return [];
        Object.assign(row, {
          handle,
          connect_token_hash: connectTokenHash,
          model,
          permission_mode: permissionMode,
          run_mode: 'daemon',
        });
        return [row];
      }
      if (normalized.startsWith('update cursorbuddy_connection_keys set status =')) {
        const [id, agentId, metadata] = params;
        const row = keys.find((key) => key.id === id);
        if (!row) return [];
        Object.assign(row, {
          status: 'claimed',
          agent_id: agentId,
          metadata,
          claimed_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        return [row];
      }
      if (normalized.startsWith('select * from cursorbuddy_connection_keys where workspace_id')) {
        return keys.filter((row) => row.workspace_id === params[0]);
      }
      return [];
    },
  };
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

test.beforeEach(() => __test.resetTestState());
test.afterEach(() => __test.resetTestState());

test('CursorBuddy setup lists real Agensis workspaces, mints a one-time key, and claim returns daemon payload', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken('user-1', '1');

  await withServer(async (baseUrl) => {
    const workspaceResponse = await fetch(`${baseUrl}/backend/workspaces`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(workspaceResponse.status, 200);
    const workspaceBody = await workspaceResponse.json();
    assert.equal(workspaceBody.data[0].id, 'ws-1');
    assert.equal(workspaceBody.data[0].role, 'owner');

    const createResponse = await fetch(`${baseUrl}/backend/cursorbuddy/connection-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        name: 'MacBook primary runtime',
        surface: 'Local CLI',
        scope: 'machine',
      }),
    });
    assert.equal(createResponse.status, 200);
    const createBody = await createResponse.json();
    assert.match(createBody.data.key, /^cbk_local_cli_[A-Z2-9]{18}$/);
    assert.match(createBody.data.command, /agensis buddy connect --key cbk_local_cli_/);
    assert.equal(createBody.data.key_hash, undefined, 'plaintext hash must not be returned');

    const claimResponse = await fetch(`${baseUrl}/backend/cursorbuddy/connection-keys/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: createBody.data.key,
        baseUrl,
        host: 'OzBook',
        cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
        runtimeKind: 'agensis-cli',
        permissionMode: 'accept_edits',
      }),
    });
    assert.equal(claimResponse.status, 200);
    const claimBody = await claimResponse.json();
    assert.equal(claimBody.data.workspaceId, 'ws-1');
    assert.equal(claimBody.data.agentId, 'agent-1');
    assert.match(claimBody.data.token, /^aga_/);
    assert.match(claimBody.data.command, /agensis connect .*--url/);
    assert.equal(claimBody.data.connectionKey.status, 'claimed');

    const secondCreateResponse = await fetch(`${baseUrl}/backend/cursorbuddy/connection-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        name: 'MacBook primary runtime',
        surface: 'Local CLI',
        scope: 'machine',
      }),
    });
    assert.equal(secondCreateResponse.status, 200);
    const secondCreateBody = await secondCreateResponse.json();
    const secondClaimResponse = await fetch(`${baseUrl}/backend/cursorbuddy/connection-keys/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: secondCreateBody.data.key,
        baseUrl,
        host: 'OzBook',
        cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
        runtimeKind: 'agensis-cli',
      }),
    });
    assert.equal(secondClaimResponse.status, 200);
    const secondClaimBody = await secondClaimResponse.json();
    assert.equal(secondClaimBody.data.agentId, 'agent-1', 'same CursorBuddy surface reuses the same workspace agent');
  });

  assert.equal(
    db.calls.filter((call) => call.normalized.includes('insert into workspace_agents')).length,
    1,
    'claim creates one reusable CursorBuddy workspace agent per surface',
  );
  assert.ok(db.calls.some((call) => call.normalized.includes('update workspace_agents set handle = $2')), 'claim rotates an aga_ daemon token');
  assert.deepEqual(JSON.parse(db.agents[0].tools), ['cursorbuddy']);
  assert.equal(JSON.parse(db.agents[0].metadata).cursorbuddyRuntime.cwd, '/Users/jkneen/Documents/GitHub/3Dpet');
});

test('CursorBuddy Provider registration creates a reusable built-in workspace agent', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken('user-1', '1');

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/backend/cursorbuddy/provider-agent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        name: 'CursorBuddy Provider localhost',
        surface: 'browser_extension',
        scope: 'domain',
        domain: 'example.test',
        websiteSource: 'https://example.test/form',
        metadata: {
          websiteSource: 'https://example.test/form',
          page: { url: 'https://example.test/form', hostname: 'example.test', title: 'Form' },
          client: { browser: 'Chrome on macOS', userAgent: 'test-agent' },
          runtime: { surface: 'extension', instanceId: 'cb-ext-test' },
          manifest: { name: 'CursorBuddy', version: '0.1.11' },
        },
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.workspaceId, 'ws-1');
    assert.equal(body.data.agentId, 'agent-1');
    assert.equal(body.data.mode, 'built_in_provider');
    assert.equal(body.data.provider, 'cursorbuddy');
    assert.equal(body.data.agent.run_mode, 'builtin');
    assert.equal(body.data.agent.handle, 'cursorbuddy-provider-example-test');

    const secondResponse = await fetch(`${baseUrl}/backend/cursorbuddy/provider-agent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        surface: 'browser_extension',
        scope: 'domain',
        domain: 'example.test',
      }),
    });
    assert.equal(secondResponse.status, 200);
    const secondBody = await secondResponse.json();
    assert.equal(secondBody.data.agentId, 'agent-1', 'same provider handle reuses the built-in agent');

    const listResponse = await fetch(`${baseUrl}/backend/workspaces/ws-1/agents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(listResponse.status, 200);
    const listBody = await listResponse.json();
    assert.equal(listBody.data.length, 1);
    assert.equal(listBody.data[0].run_mode, 'builtin');
    assert.equal(listBody.data[0].handle, 'cursorbuddy-provider-example-test');
  });

  assert.equal(db.agents.length, 1);
  assert.equal(db.agents[0].run_mode, 'builtin');
  assert.equal(db.agents[0].permission_mode, 'default');
  const tools = JSON.parse(db.agents[0].tools);
  assert.deepEqual(tools, ['cursorbuddy']);
  assert.equal(tools.some((tool) => /https?:|example\.test|userAgent|websiteSource|intent|referrer/i.test(tool)), false);
  const metadata = JSON.parse(db.agents[0].metadata).cursorbuddyProvider;
  assert.equal(metadata.mode, 'built_in_provider');
  assert.equal(metadata.websiteSource, 'https://example.test/form');
  assert.ok(db.calls.some((call) => call.normalized.includes('select * from workspace_agents where workspace_id = $1 and handle = $2')), 'provider setup looks for an existing built-in agent');
});

test('Agensis CLI setup creates or reuses a primary daemon agent and returns daemon args', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken('user-1', '1');

  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/backend/agensis/setup/connect`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        workspaceId: 'ws-1',
        host: 'OzBook-M3-4.local',
        cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
        handle: 'mac',
        name: 'mac',
        baseUrl,
      }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.workspaceId, 'ws-1');
    assert.equal(body.data.agentId, 'agent-1');
    assert.match(body.data.token, /^aga_/);
    assert.match(body.data.command, /agensis connect --url/);
    assert.deepEqual(body.data.daemonArgs, {
      command: 'connect',
      url: baseUrl,
      token: body.data.token,
      workspace: 'ws-1',
      agent: 'agent-1',
      handle: 'mac',
      name: 'mac',
      cwd: '/Users/jkneen/Documents/GitHub/3Dpet',
      model: 'claude-opus-4-8',
      permissionMode: 'default',
    });
  });

  assert.ok(db.calls.some((call) => call.normalized.includes('select * from workspace_agents where workspace_id = $1 and handle = $2')), 'setup looks for an existing machine agent by handle');
  assert.ok(db.calls.some((call) => call.normalized.includes('insert into workspace_agents')), 'setup creates a primary machine agent when needed');
  assert.ok(db.calls.some((call) => call.normalized.includes('update workspace_agents set handle = $2')), 'setup rotates an aga_ daemon token');
});

test('CursorBuddy pairing helpers keep key shape and surface normalization stable', () => {
  assert.match(__test.createCursorBuddyConnectionKey('Browser Extension'), /^cbk_browser_extension_[A-Z2-9]{18}$/);
  assert.equal(__test.normalizeCursorBuddySurface('extension'), 'browser_extension');
  assert.equal(__test.normalizeCursorBuddySurface('Desktop app'), 'desktop_app');
  assert.equal(__test.normalizeCursorBuddyScope('Domain'), 'domain');
  const publicKey = __test.publicCursorBuddyConnectionKey({
    id: 'k',
    workspace_id: 'ws',
    key_hash: 'secret',
    metadata: '{"ok":true}',
  });
  assert.equal(publicKey.key_hash, undefined);
  assert.deepEqual(publicKey.metadata, { ok: true });
});
