const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../server/mcp.cjs');
const { __test } = require('../server/index.cjs');
const { roleHasWorkspaceCapability } = __test;

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const AGENT = { kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder', agent: { model: 'claude-opus-4-8', description: 'coding agent' } };
const VOICE_AGENT = {
 ...AGENT,
 voiceSession: true,
 voiceSessionId: 'ch-1',
 huddleId: 'huddle-1',
};
const INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-1', name: 'cursor@x.com', autoApprove: true, role: 'editor' };
const VIEWER_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-viewer', name: 'viewer@x.com', autoApprove: true, role: 'viewer' };
const COMMENTER_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-commenter', name: 'commenter@x.com', autoApprove: true, role: 'commenter' };
const EDITOR_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-editor', name: 'editor@x.com', autoApprove: true, role: 'editor' };
const ADMIN_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-admin', name: 'admin@x.com', autoApprove: true, role: 'admin' };
const WORKSPACE = { kind: 'workspace', workspaceId: WS, name: 'MCP client', autoApprove: false };
const USER_IDENTITY = { kind: 'user', userId: 'user-1', workspaceId: WS, name: 'MCP client', autoApprove: false };
const CONTROLLER_REGISTER = {
  kind: 'controller',
  controllerId: 'controller-1',
  workspaceId: WS,
  name: 'Build farm',
  scopes: ['agents:register'],
};
const CONTROLLER_MANAGE = {
  ...CONTROLLER_REGISTER,
  scopes: ['agents:register', 'agents:manage_own'],
};
const CONTROLLER_RESOURCES = {
  ...CONTROLLER_REGISTER,
  scopes: ['resources:create', 'resources:manage_own'],
};
const FLOW_CHANNEL = {
  kind: 'integration',
  connectionId: 'flow-1',
  workspaceId: WS,
  channelId: 'ch-1',
  name: 'Flows',
  scopes: ['channels:read', 'messages:read', 'messages:write', 'agents:read', 'agents:dispatch'],
};

// Task rows the fake DB serves. t-root -> t-child -> t-grand is a 3-deep tree
// in WS; t-other belongs to OTHER_WS and must never be reachable as a parent.
// d-a -> d-b -> d-c is a dependency CHAIN in WS (d-b depends_on d-a, etc.) —
// the shape an agent produces when it plans "Ship UI work / 1..3". Making d-a
// depend on d-c would close the loop and hang any topological layout.
const TASK_ROWS = {
  't-root': { id: 't-root', workspace_id: WS, parent_id: null, title: 'Root' },
  't-child': { id: 't-child', workspace_id: WS, parent_id: 't-root', title: 'Child' },
  't-grand': { id: 't-grand', workspace_id: WS, parent_id: 't-child', title: 'Grandchild' },
  't-other': { id: 't-other', workspace_id: OTHER_WS, parent_id: null, title: 'Foreign' },
  'd-a': { id: 'd-a', workspace_id: WS, parent_id: null, title: 'Step 1', depends_on: [] },
  'd-b': { id: 'd-b', workspace_id: WS, parent_id: null, title: 'Step 2', depends_on: ['d-a'] },
  'd-c': { id: 'd-c', workspace_id: WS, parent_id: null, title: 'Step 3', depends_on: ['d-b'] },
  // A chain longer than MAX_TASK_DEPTH (64): deep-0 -> deep-1 -> … -> deep-79.
  // deep-0 is the ROOT of it, so walking up from deep-79 takes 79 hops and
  // blows past the cap. The old guard exited the loop quietly at 64 and
  // ACCEPTED the parent, so a long enough chain bypassed cycle detection
  // entirely — and tasks.parent_id is ON DELETE CASCADE.
  ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => [
    `deep-${i}`,
    { id: `deep-${i}`, workspace_id: WS, parent_id: i === 0 ? null : `deep-${i - 1}`, title: `Deep ${i}` },
  ])),
};

// Minimal fake postgres client. Recognizes only the statements the MCP tools
// under test issue; everything else returns []. Channels: ch-1 in WS, ch-x in OTHER_WS.
function makeDb() {
  let messageSeq = 0;
  const db = {
    calls: [],
    inserted: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params });
      if (n.startsWith('select id from chat_sessions where id = $1 and workspace_id = $2')) {
        const [id, ws] = params;
        return (id === 'ch-1' && ws === WS) ? [{ id: 'ch-1' }] : [];
      }
      if (n.startsWith('select id, session_id from thread_items where id = $1 and workspace_id = $2')) {
        if (params[1] !== WS) return [];
        if (params[0] === 'item-1') return [{ id: 'item-1', session_id: 'ch-1' }];
        if (params[0] === 'item-other') return [{ id: 'item-other', session_id: 'ch-other' }];
        return [];
      }
      if (n.startsWith('insert into messages')
        || (n.startsWith('with live_channel') && n.includes('insert into messages'))) {
        messageSeq += 1;
        const row = {
          id: `m-${messageSeq}`, session_id: params[0], content: params[1],
          thread_parent_id: params[2] ?? null, sender_kind: params[3], sender_id: params[4], sender_name: params[5],
          broadcast_to_channel: params.length > 6 ? Boolean(params[6]) : false,
        };
        db.inserted.push(row);
        return [row];
      }
      if (n.startsWith('update chat_sessions set updated_at')) return [];
      // Tasks. Tree in WS: t-root -> t-child -> t-grand. t-other lives in OTHER_WS.
      if (n.startsWith('select id, parent_id, assignee_id from tasks where id = $1 and workspace_id = $2')
        || n.startsWith('select id, parent_id from tasks where id = $1 and workspace_id = $2')
        || n.startsWith('select parent_id from tasks where id = $1 and workspace_id = $2')) {
        const [id, ws] = params;
        const row = TASK_ROWS[id];
        return (row && row.workspace_id === ws)
          ? [{ id: row.id, parent_id: row.parent_id, assignee_id: row.assignee_id ?? null }]
          : [];
      }
      if (n.startsWith('insert into tasks')) {
        const row = { id: 't-new', workspace_id: params[0], title: params[2], parent_id: params[8] };
        db.inserted.push(row);
        return [row];
      }
      if (n.startsWith('update tasks set')) {
        return [{ id: params[0], workspace_id: params[1], parent_id: params[8] }];
      }
      if (n.startsWith('select * from tasks where workspace_id = $1')) {
        return Object.values(TASK_ROWS).filter((r) => r.workspace_id === params[0]);
      }
      // The dependency-graph read: proves every proposed id lives in THIS
      // workspace and supplies the edges the cycle walk follows.
      if (n.startsWith('select id, depends_on from tasks where workspace_id = $1')) {
        return Object.values(TASK_ROWS)
          .filter((r) => r.workspace_id === params[0])
          .map((r) => ({ id: r.id, depends_on: r.depends_on || [] }));
      }
      return [];
    },
  };
  return db;
}

function makeDeps(overrides = {}) {
  const continueCalls = [];
  const notifyCalls = [];
  const tokenMap = overrides.tokenMap || {
    'good-token': AGENT,
    'invite-token': INVITE,
    'ws-token': WORKSPACE,
    'user-token': USER_IDENTITY,
    'viewer-invite-token': VIEWER_INVITE,
    'commenter-invite-token': COMMENTER_INVITE,
    'editor-invite-token': EDITOR_INVITE,
    'admin-invite-token': ADMIN_INVITE,
    'flow-token': FLOW_CHANNEL,
    'voice-token': VOICE_AGENT,
    'controller-register-token': CONTROLLER_REGISTER,
    'controller-manage-token': CONTROLLER_MANAGE,
    'controller-resources-token': CONTROLLER_RESOURCES,
  };
  const deps = {
    getDb: () => overrides.db,
    verifyMcpToken: async (token) => tokenMap[token] || null,
    continueConversation: async (arg) => { continueCalls.push(arg); },
    notifyDbSubscribers: (table, ev, rows) => { notifyCalls.push({ table, ev, rows }); },
    slugHandle: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
    claimMcpJob: async () => null,
    submitMcpJobResult: async () => ({ jobId: 'x', status: 'done' }),
    resolveWorkspaceAgentByHandle: async (_ws, handle) => (handle === 'coder' ? { id: 'agent-1', handle: 'coder', name: 'Coder', mcp_approved: true } : null),
    registerAgentRequest: async (arg) => ({ registrationId: 'reg-1', status: arg.autoApprove ? 'approved' : 'pending', handle: arg.asHandle || arg.handle || arg.name || 'agent' }),
    getRegistrationStatus: async () => ({ registrationId: 'reg-1', status: 'approved', agentId: 'agent-1', handle: 'coder' }),
    roleHasWorkspaceCapability,
    rateLimiter: null,
    rateLimitBlocked: null,
    runtimeSchemaReady: Promise.resolve(),
    serverVersion: '9.9.9',
    ...overrides.deps,
  };
  return { deps, continueCalls, notifyCalls };
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
  };
}

async function call(handler, { token = 'good-token', body }) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body, url: '/backend/mcp' };
  const res = makeRes();
  await handler(req, res);
  return res;
}

function rpc(method, params, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

test('rejects missing/invalid token with 401', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);

  const noAuth = await call(handler, { token: null, body: rpc('tools/list') });
  assert.equal(noAuth.statusCode, 401);
  assert.equal(noAuth.headers['WWW-Authenticate'], 'Bearer realm="agensis-mcp"');

  const badAuth = await call(handler, { token: 'nope', body: rpc('tools/list') });
  assert.equal(badAuth.statusCode, 401);
});

test('initialize advertises tools + serverInfo and echoes protocolVersion', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('initialize', { protocolVersion: '2025-06-18' }) });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.result.protocolVersion, '2025-06-18');
  assert.equal(res.body.result.serverInfo.name, 'agensis');
  assert.equal(res.body.result.serverInfo.version, '9.9.9');
  assert.ok(res.body.result.capabilities.tools);
  assert.ok(typeof res.body.result.instructions === 'string');
});

test('tools/list exposes the full surface', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/list') });
  const names = res.body.result.tools.map((t) => t.name);
  for (const expected of [
    'whoami', 'list_channels', 'read_channel', 'search_messages', 'list_members', 'list_agents',
    'list_workspace_resources', 'get_workspace_resource', 'request_resource_operation',
    'list_resource_operations', 'get_resource_operation', 'claim_resource_operation',
    'settle_resource_operation',
    'post_message', 'dispatch_agent', 'create_channel',
    'list_docs', 'read_doc', 'write_doc', 'search_docs',
    'list_tasks', 'create_task', 'update_task',
    'get_workspace_memory', 'add_memory',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  // Every tool must carry an inputSchema object.
  for (const t of res.body.result.tools) {
    assert.equal(t.inputSchema.type, 'object', `${t.name} schema`);
  }
});

test('standing permission-rule tools are manage-only and dispatch through the audited services', async () => {
  const db = makeDb();
  const calls = [];
  const { deps } = makeDeps({
    db,
    deps: {
      listAgentPermissionRules: async (input) => {
        calls.push({ operation: 'list', input });
        return ['WebFetch'];
      },
      grantAgentPermissionRule: async (input) => {
        calls.push({ operation: 'grant', input });
        return ['WebFetch', input.rule];
      },
      revokeAgentPermissionRule: async (input) => {
        calls.push({ operation: 'revoke', input });
        return ['WebFetch'];
      },
    },
  });
  const handler = createMcpHandler(deps);

  const agentList = await call(handler, { token: 'good-token', body: rpc('tools/list') });
  const agentTools = agentList.body.result.tools.map((tool) => tool.name);
  assert.ok(!agentTools.includes('list_agent_permission_rules'));
  assert.ok(!agentTools.includes('grant_agent_permission_rule'));
  assert.ok(!agentTools.includes('revoke_agent_permission_rule'));

  const denied = await call(handler, {
    token: 'good-token',
    body: rpc('tools/call', {
      name: 'grant_agent_permission_rule',
      arguments: { agent_id: 'agent-1', rule: 'Bash(git status:*)' },
    }),
  });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /not available for a agent token/i);
  assert.equal(calls.length, 0, 'an agent credential must be refused before the service runs');

  for (const token of ['ws-token', 'user-token']) {
    const listed = await call(handler, {
      token,
      body: rpc('tools/call', {
        name: 'list_agent_permission_rules', arguments: { agent_id: 'agent-1' },
      }),
    });
    assert.deepEqual(JSON.parse(listed.body.result.content[0].text).rules, ['WebFetch']);
  }
  const granted = await call(handler, {
    token: 'ws-token',
    body: rpc('tools/call', {
      name: 'grant_agent_permission_rule',
      arguments: { agent_id: 'agent-1', rule: 'Bash(git status:*)' },
    }),
  });
  assert.deepEqual(JSON.parse(granted.body.result.content[0].text).rules, ['WebFetch', 'Bash(git status:*)']);
  const revoked = await call(handler, {
    token: 'ws-token',
    body: rpc('tools/call', {
      name: 'revoke_agent_permission_rule',
      arguments: { agent_id: 'agent-1', rule: 'Bash(git status:*)' },
    }),
  });
  assert.deepEqual(JSON.parse(revoked.body.result.content[0].text).rules, ['WebFetch']);

  assert.deepEqual(calls.map((entry) => entry.operation), ['list', 'list', 'grant', 'revoke']);
  assert.equal(calls[0].input.actor.kind, 'workspace');
  assert.equal(calls[1].input.actor.kind, 'user');
  for (const entry of calls) {
    assert.equal(entry.input.workspaceId, WS);
    assert.equal(entry.input.agentId, 'agent-1');
  }
});

test('voice session credentials expose only pinned read tools and transcript context', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);

  const listed = await call(handler, {
    token: 'voice-token',
    body: rpc('tools/list'),
  });
  assert.deepEqual(
    listed.body.result.tools.map((tool) => tool.name).sort(),
    ['list_docs', 'list_skills', 'read_channel', 'read_doc', 'read_skill', 'search_docs'],
  );

  const allowed = await call(handler, {
    token: 'voice-token',
    body: rpc('tools/call', { name: 'read_channel', arguments: { channel_id: 'ch-1', limit: 4 } }),
  });
  assert.equal(allowed.body.result.isError ?? false, false);

  const wrongChannel = await call(handler, {
    token: 'voice-token',
    body: rpc('tools/call', { name: 'read_channel', arguments: { channel_id: 'other-channel' } }),
  });
  assert.equal(wrongChannel.body.result.isError, true);
  assert.match(wrongChannel.body.result.content[0].text, /pinned to this huddle transcript/i);

  const write = await call(handler, {
    token: 'voice-token',
    body: rpc('tools/call', { name: 'post_message', arguments: { channel_id: 'ch-1', content: 'escape' } }),
  });
  assert.equal(write.body.result.isError, true);
  assert.match(write.body.result.content[0].text, /voice session token/i);
  assert.equal(db.inserted.length, 0, 'a voice bearer cannot reach a workspace write');
});

test('whoami returns the resolved agent identity', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'whoami', arguments: {} }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.agentId, 'agent-1');
  assert.equal(payload.handle, 'coder');
  assert.equal(payload.workspaceId, WS);
});

test('a controller discovers only tools backed by its explicit scopes', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const listed = await call(handler, {
    token: 'controller-register-token',
    body: rpc('tools/list'),
  });
  assert.deepEqual(
    listed.body.result.tools.map(tool => tool.name).sort(),
    ['register_agent', 'registration_status', 'whoami'],
  );

  const who = await call(handler, {
    token: 'controller-register-token',
    body: rpc('tools/call', { name: 'whoami', arguments: {} }),
  });
  const payload = JSON.parse(who.body.result.content[0].text);
  assert.equal(payload.kind, 'controller');
  assert.equal(payload.controllerId, 'controller-1');
  assert.deepEqual(payload.scopes, ['agents:register']);
  assert.match(payload.note, /cannot read private sessions/i);
});

test('controller registration is auto-approved and attributed to the controller', async () => {
  const db = makeDb();
  const registrations = [];
  const { deps } = makeDeps({
    db,
    deps: {
      registerAgentRequest: async args => {
        registrations.push(args);
        return { registrationId: 'reg-controller', status: 'approved', handle: 'child' };
      },
    },
  });
  const handler = createMcpHandler(deps);
  const response = await call(handler, {
    token: 'controller-register-token',
    body: rpc('tools/call', {
      name: 'register_agent',
      arguments: { name: 'Child agent' },
    }),
  });
  assert.equal(response.body.result.isError ?? false, false);
  assert.equal(registrations[0].autoApprove, true);
  assert.equal(registrations[0].controllerId, 'controller-1');
});

test('a controller can operate only agents attributed to it', async () => {
  const db = makeDb();
  const claims = [];
  const { deps } = makeDeps({
    db,
    deps: {
      resolveWorkspaceAgentByHandle: async (_workspaceId, handle) => ({
        id: handle === 'owned' ? 'agent-owned' : 'agent-foreign',
        handle,
        name: handle,
        mcp_approved: true,
        controller_id: handle === 'owned' ? 'controller-1' : 'controller-2',
      }),
      claimMcpJob: async args => {
        claims.push(args);
        return null;
      },
    },
  });
  const handler = createMcpHandler(deps);
  const foreign = await call(handler, {
    token: 'controller-manage-token',
    body: rpc('tools/call', { name: 'claim_job', arguments: { as: 'foreign' } }),
  });
  assert.equal(foreign.body.result.isError, true);
  assert.match(foreign.body.result.content[0].text, /not owned by this controller/i);
  assert.equal(claims.length, 0);

  const owned = await call(handler, {
    token: 'controller-manage-token',
    body: rpc('tools/call', { name: 'claim_job', arguments: { as: 'owned' } }),
  });
  assert.equal(owned.body.result.isError ?? false, false);
  assert.equal(claims[0].agentId, 'agent-owned');
});

test('resource tools are visible only to identities with the matching authority', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);

  const agentNames = (await call(handler, {
    token: 'good-token',
    body: rpc('tools/list'),
  })).body.result.tools.map(tool => tool.name);
  for (const name of [
    'list_workspace_resources', 'get_workspace_resource', 'request_resource_operation',
    'list_resource_operations', 'get_resource_operation', 'claim_resource_operation',
    'settle_resource_operation',
  ]) assert.ok(agentNames.includes(name), `agent missing ${name}`);
  assert.ok(!agentNames.includes('create_workspace_resource'));
  assert.ok(!agentNames.includes('update_workspace_resource'));

  const userNames = (await call(handler, {
    token: 'user-token',
    body: rpc('tools/list'),
  })).body.result.tools.map(tool => tool.name);
  for (const name of [
    'list_workspace_resources', 'get_workspace_resource', 'create_workspace_resource',
    'update_workspace_resource', 'request_resource_operation', 'list_resource_operations',
    'get_resource_operation', 'delete_workspace_resource', 'restore_workspace_resource',
  ]) assert.ok(userNames.includes(name), `user missing ${name}`);
  assert.ok(!userNames.includes('claim_resource_operation'));
  assert.ok(!userNames.includes('settle_resource_operation'));

  const controllerNames = (await call(handler, {
    token: 'controller-resources-token',
    body: rpc('tools/list'),
  })).body.result.tools.map(tool => tool.name).sort();
  assert.deepEqual(controllerNames, [
    'create_workspace_resource', 'delete_workspace_resource', 'get_resource_operation', 'get_workspace_resource',
    'list_resource_operations', 'list_workspace_resources', 'request_resource_operation',
    'restore_workspace_resource', 'update_workspace_resource', 'whoami',
  ].sort());
  assert.ok(!controllerNames.includes('list_channels'));
  assert.ok(!controllerNames.includes('claim_resource_operation'));

  const registerOnlyNames = (await call(handler, {
    token: 'controller-register-token',
    body: rpc('tools/list'),
  })).body.result.tools.map(tool => tool.name);
  assert.ok(!registerOnlyNames.includes('list_workspace_resources'));
});

test('resource tools derive the actor solely from the authenticated identity', async () => {
  const db = makeDb();
  const calls = [];
  const workspaceResources = Object.fromEntries([
    'listResources', 'getResource', 'createResource', 'updateResource', 'requestOperation',
    'listOperations', 'getOperation', 'claimOperation', 'settleOperation',
  ].map(method => [method, async input => {
    calls.push({ method, input });
    return method.startsWith('list') ? [] : { id: `${method}-result` };
  }]));
  const { deps } = makeDeps({ db, deps: { workspaceResources } });
  const handler = createMcpHandler(deps);

  const created = await call(handler, {
    token: 'controller-resources-token',
    body: rpc('tools/call', {
      name: 'create_workspace_resource',
      arguments: { steward_agent_id: 'steward-1', name: 'Codebase', facet: 'code' },
    }),
  });
  assert.equal(created.body.result.isError ?? false, false);
  assert.deepEqual(calls.at(-1).input.actor, {
    kind: 'controller', controllerId: 'controller-1', workspaceId: WS,
  });
  assert.equal(calls.at(-1).input.workspaceId, WS);

  const requested = await call(handler, {
    token: 'good-token',
    body: rpc('tools/call', {
      name: 'request_resource_operation',
      arguments: {
        resource_id: 'resource-1', operation: 'read', idempotency_key: 'read-1',
      },
    }),
  });
  assert.equal(requested.body.result.isError ?? false, false);
  assert.deepEqual(calls.at(-1).input.requester, {
    kind: 'agent', agentId: 'agent-1', workspaceId: WS,
  });

  const claimed = await call(handler, {
    token: 'good-token',
    body: rpc('tools/call', { name: 'claim_resource_operation', arguments: {} }),
  });
  assert.equal(claimed.body.result.isError ?? false, false);
  assert.deepEqual(calls.at(-1).input.actor, {
    kind: 'agent', agentId: 'agent-1', workspaceId: WS,
  });

  const settled = await call(handler, {
    token: 'good-token',
    body: rpc('tools/call', {
      name: 'settle_resource_operation',
      arguments: {
        operation_id: 'operation-1', lease_version: '7', status: 'completed',
        output_artifact: { commit: 'abc123' },
      },
    }),
  });
  assert.equal(settled.body.result.isError ?? false, false);
  assert.deepEqual(calls.at(-1).input.actor, {
    kind: 'agent', agentId: 'agent-1', workspaceId: WS,
  });
  assert.equal(calls.at(-1).input.leaseVersion, '7');
});

test('resource tools fail closed when the service is absent or refuses access', async () => {
  const db = makeDb();
  const missingHandler = createMcpHandler(makeDeps({ db }).deps);
  const missing = await call(missingHandler, {
    token: 'good-token',
    body: rpc('tools/call', { name: 'list_workspace_resources', arguments: {} }),
  });
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /not available on this backend/i);

  const denied = new Error('Resource is outside this controller lineage');
  denied.status = 403;
  const { deps } = makeDeps({
    db,
    deps: { workspaceResources: { listResources: async () => { throw denied; } } },
  });
  const deniedHandler = createMcpHandler(deps);
  const response = await call(deniedHandler, {
    token: 'controller-resources-token',
    body: rpc('tools/call', { name: 'list_workspace_resources', arguments: {} }),
  });
  assert.equal(response.body.result.isError, true);
  assert.match(response.body.result.content[0].text, /outside this controller lineage/i);
});

test('channel-scoped Flows connections discover only granted tools and cannot cross channels', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const listed = await call(handler, { token: 'flow-token', body: rpc('tools/list') });
  const names = listed.body.result.tools.map((tool) => tool.name);

  assert.ok(names.includes('read_channel'));
  assert.ok(names.includes('post_message'));
  assert.ok(names.includes('dispatch_agent'));
  assert.equal(names.includes('read_doc'), false);
  assert.equal(names.includes('register_agent'), false);

  const denied = await call(handler, {
    token: 'flow-token', body: rpc('tools/call', {
      name: 'read_channel', arguments: { channel_id: 'ch-x' },
    })
  });
  assert.equal(denied.body.result.isError, true);
  assert.match(denied.body.result.content[0].text, /limited to a different channel/i);

  const posted = await call(handler, {
    token: 'flow-token', body: rpc('tools/call', {
      name: 'post_message', arguments: { channel_id: 'ch-1', content: 'workflow reply' },
    })
  });
  assert.equal(JSON.parse(posted.body.result.content[0].text).posted, true);
  assert.equal(db.inserted[0].sender_kind, 'integration');
  assert.equal(db.inserted[0].sender_name, 'Flows');

  const deniedThreadUpdate = await call(handler, {
    token: 'flow-token', body: rpc('tools/call', {
      name: 'update_thread_item', arguments: { item_id: 'item-other', status: 'done' },
    })
  });
  assert.equal(deniedThreadUpdate.body.result.isError, true);
  assert.match(deniedThreadUpdate.body.result.content[0].text, /limited to a different channel/i);
});

test('a channel-pinned integration cannot enumerate its channel after deletion', async () => {
  const calls = [];
  const db = {
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ normalized, params });
      if (!normalized.includes('from chat_sessions') || !normalized.includes('id = $2')) return [];
      // Model PostgreSQL faithfully: the deleted row exists, but the live-row
      // predicate must filter it. If production drops that predicate this fake
      // deliberately returns the row and the behavioural assertion fails.
      return normalized.includes('deleted_at is null')
        ? []
        : [{ id: 'ch-1', title: 'Deleted channel', deleted_at: '2026-07-31T00:00:00.000Z' }];
    },
  };
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const response = await call(handler, {
    token: 'flow-token',
    body: rpc('tools/call', { name: 'list_channels', arguments: {} }),
  });
  const payload = JSON.parse(response.body.result.content[0].text);

  assert.deepEqual(payload.channels, []);
  assert.equal(payload.next_cursor, null);
  assert.ok(
    calls.some(({ normalized }) =>
      normalized.includes('where workspace_id = $1 and id = $2 and deleted_at is null')),
    'the pinned branch must query only a live channel',
  );
});

test('post_message inserts + notifies but does NOT trigger continueConversation', async () => {
  const db = makeDb();
  const { deps, continueCalls, notifyCalls } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    body: rpc('tools/call', {
      name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hello team' },
    })
  });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.posted, true);
  assert.equal(payload.message.content, 'hello team');
  assert.equal(db.inserted.length, 1);
  assert.ok(notifyCalls.some((c) => c.table === 'messages' && c.ev === 'INSERT'));
  assert.equal(continueCalls.length, 0, 'post_message must NOT advance the conversation');
});

test('dispatch_agent inserts AND fires continueConversation (the trigger path)', async () => {
  const db = makeDb();
  const { deps, continueCalls } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    body: rpc('tools/call', {
      name: 'dispatch_agent', arguments: { channel_id: 'ch-1', content: '@scout find the bug' },
    })
  });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.dispatched, true);
  assert.equal(db.inserted.length, 1);
  // Fire-and-forget: continueConversation is invoked, but not awaited inside the handler.
  // It resolves synchronously here, so it has run by the time we assert.
  assert.equal(continueCalls.length, 1, 'dispatch_agent must advance the conversation');
  assert.deepEqual(continueCalls[0], { workspaceId: WS, sessionId: 'ch-1', threadParentId: null });
});

test('post_message: broadcast_to_channel is ignored on a top-level (non-thread) post', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  await call(handler, {
    body: rpc('tools/call', {
      name: 'post_message', arguments: { channel_id: 'ch-1', content: 'flat post', broadcast_to_channel: true },
    })
  });
  assert.equal(db.inserted[0].thread_parent_id, null);
  assert.equal(db.inserted[0].broadcast_to_channel, false, 'nothing to broadcast OUT of when there is no thread');
});

test('post_message: broadcast_to_channel true on a thread reply flags it for the channel view', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  await call(handler, {
    body: rpc('tools/call', {
      name: 'post_message',
      arguments: { channel_id: 'ch-1', content: 'need your input on X', thread_parent_id: 'root-1', broadcast_to_channel: true },
    })
  });
  assert.equal(db.inserted[0].thread_parent_id, 'root-1');
  assert.equal(db.inserted[0].broadcast_to_channel, true);
});

test('post_message: a thread reply defaults to NOT broadcasting when the flag is omitted', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  await call(handler, {
    body: rpc('tools/call', {
      name: 'post_message', arguments: { channel_id: 'ch-1', content: 'routine progress note', thread_parent_id: 'root-1' },
    })
  });
  assert.equal(db.inserted[0].broadcast_to_channel, false);
});

test('dispatch_agent: broadcast_to_channel true on a thread reply flags it AND still advances the conversation', async () => {
  const db = makeDb();
  const { deps, continueCalls } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  await call(handler, {
    body: rpc('tools/call', {
      name: 'dispatch_agent',
      arguments: { channel_id: 'ch-1', content: '@jason can I deploy this?', thread_parent_id: 'root-1', broadcast_to_channel: true },
    })
  });
  assert.equal(db.inserted[0].broadcast_to_channel, true);
  assert.equal(db.inserted[0].thread_parent_id, 'root-1');
  assert.equal(continueCalls.length, 1, 'broadcasting a message must not skip advancing the conversation');
});

test('cross-workspace access is blocked (channel scoping)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  // ch-x lives in OTHER_WS; the agent is scoped to WS, so the lookup misses.
  const res = await call(handler, {
    body: rpc('tools/call', {
      name: 'read_channel', arguments: { channel_id: 'ch-x' },
    })
  });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not found in this workspace/i);
});

test('unknown tool returns an isError result (not a protocol crash)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'no_such_tool', arguments: {} }) });
  assert.equal(res.body.result.isError, true);
});

test('notifications get no response (202)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.ended, true);
});

test('unknown method returns -32601', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('frobnicate', {}) });
  assert.equal(res.body.error.code, -32601);
});

test('batch requests are processed and notifications dropped from the array', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    body: [
      rpc('initialize', {}, 1),
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      rpc('tools/list', {}, 2),
    ]
  });
  assert.ok(Array.isArray(res.body));
  assert.equal(res.body.length, 2);
  assert.deepEqual(res.body.map((r) => r.id).sort(), [1, 2]);
});

// --- MCP pull worker tools (work AS an agent) -------------------------------

test('tools/list includes the pull worker tools', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const names = (await call(handler, { body: rpc('tools/list') })).body.result.tools.map((t) => t.name);
  for (const t of ['claim_job', 'submit_job_result', 'fail_job']) assert.ok(names.includes(t), `missing ${t}`);
});

test('whoami reports kind=agent and kind=invite', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const a = JSON.parse((await call(handler, { body: rpc('tools/call', { name: 'whoami', arguments: {} }) })).body.result.content[0].text);
  assert.equal(a.kind, 'agent');
  const i = JSON.parse((await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'whoami', arguments: {} }) })).body.result.content[0].text);
  assert.equal(i.kind, 'invite');
  assert.equal(i.workspaceId, WS);
});

test('an agent token claims for itself (no `as` needed)', async () => {
  const db = makeDb();
  const claims = [];
  const { deps } = makeDeps({ db, deps: { claimMcpJob: async (arg) => { claims.push(arg); return null; } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'claim_job', arguments: {} }) });
  assert.deepEqual(JSON.parse(res.body.result.content[0].text), { job: null });
  assert.equal(claims[0].agentId, 'agent-1');
});

test('an invite client must pass `as`, and it resolves to the agent', async () => {
  const db = makeDb();
  const claims = [];
  const { deps } = makeDeps({ db, deps: { claimMcpJob: async (arg) => { claims.push(arg); return { job: null }; } } });
  const handler = createMcpHandler(deps);

  const missing = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'claim_job', arguments: {} }) });
  assert.equal(missing.body.result.isError, true);
  assert.match(missing.body.result.content[0].text, /which agent to work as/i);

  const ok = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'claim_job', arguments: { as: 'coder' } }) });
  assert.ok(!ok.body.result.isError);
  assert.equal(claims[0].agentId, 'agent-1');
});

test('an invite client gets a clear error for an unknown agent handle', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'claim_job', arguments: { as: 'ghost' } }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /No agent "@ghost"/i);
});

test('post_message: non-agent client needs `as`; role-gated; posts as the resolved agent', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  // (a) Without `as`, a workspace/invite client is told which handle to speak as.
  const noAs = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hi' } }) });
  assert.equal(noAs.body.result.isError, true);
  assert.match(noAs.body.result.content[0].text, /Pass `as/i);
  // (b) A read-only (viewer) invite is denied by the run_agents capability, even with `as`.
  const viewer = await call(handler, { token: 'viewer-invite-token', body: rpc('tools/call', { name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hi', as: 'coder' } }) });
  assert.equal(viewer.body.result.isError, true);
  assert.match(viewer.body.result.content[0].text, /read-only|cannot act as an agent/i);
  // (c) An editor invite with an approved handle posts, attributed to that agent.
  const posted = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hello team', as: 'coder' } }) });
  assert.equal(posted.body.result.isError, undefined);
  const row = db.inserted[db.inserted.length - 1];
  assert.equal(row.sender_kind, 'agent');
  assert.equal(row.sender_id, 'agent-1');
  assert.equal(row.sender_name, 'Coder');
});

test('workspace token sees post_message/dispatch_agent in tools/list and dispatch advances the convo', async () => {
  const db = makeDb();
  const { deps, continueCalls } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  // The original bug: a workspace-token client could not even see these tools.
  const list = await call(handler, { token: 'ws-token', body: rpc('tools/list', {}) });
  const names = list.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('post_message'), 'workspace token must see post_message');
  assert.ok(names.includes('dispatch_agent'), 'workspace token must see dispatch_agent');
  // dispatch_agent as a workspace client, speaking as coder, advances the conversation.
  const res = await call(handler, { token: 'ws-token', body: rpc('tools/call', { name: 'dispatch_agent', arguments: { channel_id: 'ch-1', content: '@scout ping', as: 'coder' } }) });
  assert.equal(res.body.result.isError, undefined);
  const row = db.inserted[db.inserted.length - 1];
  assert.equal(row.sender_id, 'agent-1');
  assert.equal(row.sender_name, 'Coder');
  assert.equal(continueCalls.length, 1);
  assert.equal(continueCalls[0].sessionId, 'ch-1');
});

test('submit_job_result forwards agentId + response; fail_job forwards errorText', async () => {
  const db = makeDb();
  const subs = [];
  const { deps } = makeDeps({ db, deps: { submitMcpJobResult: async (arg) => { subs.push(arg); return { jobId: arg.jobId, status: arg.errorText ? 'error' : 'done' }; } } });
  const handler = createMcpHandler(deps);
  await call(handler, { body: rpc('tools/call', { name: 'submit_job_result', arguments: { job_id: 'j1', response: 'hello' } }) });
  assert.deepEqual({ agentId: subs[0].agentId, jobId: subs[0].jobId, responseText: subs[0].responseText }, { agentId: 'agent-1', jobId: 'j1', responseText: 'hello' });
  await call(handler, { body: rpc('tools/call', { name: 'fail_job', arguments: { job_id: 'j2', error: 'timeout' } }) });
  assert.equal(subs[1].errorText, 'timeout');
});

// --- register_agent / approval ---------------------------------------------

test('register_agent is available to workspace/invite, not to a per-agent token', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const asAgent = await call(handler, { body: rpc('tools/call', { name: 'register_agent', arguments: { name: 'X' } }) });
  assert.equal(asAgent.body.result.isError, true);
  assert.match(asAgent.body.result.content[0].text, /not available for a agent token/i);
});

test('a workspace client registers a new agent → pending (popup)', async () => {
  const db = makeDb();
  const calls = [];
  const { deps } = makeDeps({ db, deps: { registerAgentRequest: async (a) => { calls.push(a); return { registrationId: 'reg-9', status: 'pending', handle: 'cursor' }; } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'ws-token', body: rpc('tools/call', { name: 'register_agent', arguments: { name: 'Cursor', label: 'laptop' } }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.status, 'pending');
  assert.equal(calls[0].name, 'Cursor');
  assert.equal(calls[0].autoApprove, false);
});

test('an invite client registers → auto-approved (autoApprove passed through)', async () => {
  const db = makeDb();
  const calls = [];
  const { deps } = makeDeps({ db, deps: { registerAgentRequest: async (a) => { calls.push(a); return { registrationId: 'r', status: a.autoApprove ? 'approved' : 'pending', handle: 'q' }; } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'register_agent', arguments: { as: 'q' } }) });
  assert.equal(JSON.parse(res.body.result.content[0].text).status, 'approved');
  assert.equal(calls[0].autoApprove, true);
});

test('a read-only invite cannot re-identity an EXISTING agent via register_agent', async () => {
  // F-identity: `as` + `identity` against an already-approved agent is applied
  // immediately — a write. An invite whose role cannot write must be refused
  // BEFORE registerAgentRequest ever runs.
  const db = makeDb();
  const calls = [];
  const { deps } = makeDeps({ db, deps: { registerAgentRequest: async (a) => { calls.push(a); return { status: 'approved', agentId: 'agent-1', handle: 'coder' }; } } });
  const handler = createMcpHandler(deps);
  for (const token of ['viewer-invite-token', 'commenter-invite-token']) {
    const res = await call(handler, { token, body: rpc('tools/call', { name: 'register_agent', arguments: { as: 'coder', identity: { avatar: 'XX' } } }) });
    assert.equal(res.body.result.isError, true, `${token} must be refused`);
    assert.match(res.body.result.content[0].text, /read-only/i);
  }
  assert.equal(calls.length, 0, 'the declaration never reaches registerAgentRequest');
});

test('an invite with write capability still declares identity for an existing agent', async () => {
  const db = makeDb();
  const calls = [];
  const { deps } = makeDeps({ db, deps: { registerAgentRequest: async (a) => { calls.push(a); return { status: 'approved', agentId: 'agent-1', handle: 'coder' }; } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'editor-invite-token', body: rpc('tools/call', { name: 'register_agent', arguments: { as: 'coder', identity: { avatar: 'XX' } } }) });
  assert.equal(res.body.result.isError ?? false, false);
  assert.deepEqual(calls[0].identity, { avatar: 'XX' });
});

test('a read-only invite may still register a BRAND NEW agent with an identity', async () => {
  // Creating a new agent overwrites nobody's choices — the identity is the
  // creation default, and that flow is exactly what invite links exist for.
  const db = makeDb();
  const calls = [];
  const { deps } = makeDeps({ db, deps: { registerAgentRequest: async (a) => { calls.push(a); return { registrationId: 'r', status: 'approved', handle: 'x' }; } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'viewer-invite-token', body: rpc('tools/call', { name: 'register_agent', arguments: { name: 'X', identity: { avatar: 'XX' } } }) });
  assert.equal(res.body.result.isError ?? false, false);
  assert.deepEqual(calls[0].identity, { avatar: 'XX' });
});

test('register_agent needs at least one of as/name/handle', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'ws-token', body: rpc('tools/call', { name: 'register_agent', arguments: {} }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /work as an existing agent, or `name`/i);
});

test('registration_status returns the current status', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db, deps: { getRegistrationStatus: async () => ({ registrationId: 'reg-1', status: 'approved', handle: 'q' }) } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'ws-token', body: rpc('tools/call', { name: 'registration_status', arguments: { registration_id: 'reg-1' } }) });
  assert.equal(JSON.parse(res.body.result.content[0].text).status, 'approved');
});

test('a workspace client cannot claim as an UNapproved agent', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db, deps: { resolveWorkspaceAgentByHandle: async () => ({ id: 'a9', handle: 'new', name: 'New', mcp_approved: false }) } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'ws-token', body: rpc('tools/call', { name: 'claim_job', arguments: { as: 'new' } }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not been approved for MCP/i);
});

test('a workspace client CAN claim as an approved agent', async () => {
  const db = makeDb();
  const claims = [];
  const { deps } = makeDeps({ db, deps: { claimMcpJob: async (a) => { claims.push(a); return null; } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'ws-token', body: rpc('tools/call', { name: 'claim_job', arguments: { as: 'coder' } }) });
  assert.ok(!res.body.result.isError);
  assert.equal(claims[0].agentId, 'agent-1');
});

// --- invite role capability gating on write tools ---------------------------
// A viewer/commenter invite grants read-only/comment-only access over HTTP
// (enforceDbOperationAccess); these tools must enforce the same `write`
// capability for invite-kind identities so an invite link never silently
// grants full write access over MCP.

test('a viewer invite cannot write_doc (create path) — rejected before any DB write', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'viewer-invite-token', body: rpc('tools/call', {
      name: 'write_doc', arguments: { title: 'Sneaky doc', content: 'hi' },
    })
  });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /read-only/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into documents')), 'must not reach the insert');
});

test('a commenter invite cannot create_task — rejected before any DB write', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'commenter-invite-token', body: rpc('tools/call', {
      name: 'create_task', arguments: { title: 'Sneaky task' },
    })
  });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /read-only/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into tasks')), 'must not reach the insert');
});

test('an editor invite CAN write_doc — no regression for the intended-write case', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'editor-invite-token', body: rpc('tools/call', {
      name: 'write_doc', arguments: { title: 'Real doc', content: 'hi' },
    })
  });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  assert.ok(db.calls.some((c) => c.n.startsWith('insert into documents')), 'must reach the insert');
});

test('an admin invite CAN add_memory — no regression for the intended-write case', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'admin-invite-token', body: rpc('tools/call', {
      name: 'add_memory', arguments: { fact: 'the sky is blue' },
    })
  });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  assert.ok(db.calls.some((c) => c.n.startsWith('insert into memory_facts')), 'must reach the insert');
});

test('a viewer invite CAN still read via a read-only tool (fix did not over-broadly block reads)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'viewer-invite-token', body: rpc('tools/call', {
      name: 'list_docs', arguments: {},
    })
  });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
});

// --- Task nesting (parent_id) ----------------------------------------------
// tasks.parent_id is ON DELETE CASCADE, so an unvalidated parent is not merely
// untidy: a cross-workspace parent leaks across tenants, and a cycle makes a
// subtree that cascades into itself.

async function callTask(name, args, token = 'good-token') {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token, body: rpc('tools/call', { name, arguments: args }) });
  return { db, res };
}

test('create_task and update_task expose parent_id in their input schemas', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/list') });
  const byName = Object.fromEntries(res.body.result.tools.map((t) => [t.name, t]));
  assert.ok(byName.create_task.inputSchema.properties.parent_id, 'create_task must accept parent_id');
  assert.ok(byName.update_task.inputSchema.properties.parent_id, 'update_task must accept parent_id');
});

test('create_task nests under a parent in the same workspace', async () => {
  const { db, res } = await callTask('create_task', { title: 'Sub', parent_id: 't-root' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into tasks'));
  assert.ok(insert, 'must reach the insert');
  assert.ok(insert.n.includes('parent_id'), 'insert must name the parent_id column');
  assert.equal(insert.params[8], 't-root');
  assert.equal(JSON.parse(res.body.result.content[0].text).task.parent_id, 't-root');
});

test('create_task without parent_id still writes a top-level task (null parent)', async () => {
  const { db, res } = await callTask('create_task', { title: 'Top level' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into tasks'));
  assert.equal(insert.params[8], null);
});

test('a human login identity creating an assigned task stamps and dispatches as that human', async () => {
  const db = makeDb();
  const dispatches = [];
  const { deps } = makeDeps({
    db,
    deps: {
      dispatchTaskAssignment: async (args) => { dispatches.push(args); },
    },
  });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'user-token',
    body: rpc('tools/call', {
      name: 'create_task',
      arguments: { title: 'Owned route', assignee_id: 'agent-next' },
    }),
  });

  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into tasks'));
  assert.ok(insert.n.includes('dispatch_requested_by'));
  assert.equal(insert.params[11], USER_IDENTITY.userId, 'created_by is authenticated, never client-authored');
  assert.equal(insert.params[12], USER_IDENTITY.userId, 'the delayed route belongs to the assigning human');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches.length, 1, 'assigned task creation follows the same dispatch contract as the UI');
  assert.equal(dispatches[0].actorUserId, USER_IDENTITY.userId);
});

test('create_task rejects a parent in ANOTHER workspace — before any insert', async () => {
  const { db, res } = await callTask('create_task', { title: 'Leaky', parent_id: 't-other' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /parent task not found in this workspace/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into tasks')), 'must not reach the insert');
});

test('create_task rejects a parent id that does not exist at all', async () => {
  const { db, res } = await callTask('create_task', { title: 'Ghost', parent_id: 't-nope' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /parent task not found in this workspace/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into tasks')), 'must not reach the insert');
});

test('update_task can re-parent a task inside the workspace', async () => {
  const { db, res } = await callTask('update_task', { task_id: 't-grand', parent_id: 't-root' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const update = db.calls.find((c) => c.n.startsWith('update tasks set'));
  // Guarded write: $10 says "the caller mentioned parent_id", $9 carries it.
  assert.ok(update.n.includes('parent_id = case when $10 then $9 else parent_id end'), 'update must set parent_id under the guard');
  assert.equal(update.params[8], 't-root');
  assert.equal(update.params[9], true, 'the guard must be ON when the caller supplies parent_id');
});

test('update_task with parent_id "" un-nests the task to top level', async () => {
  const { db, res } = await callTask('update_task', { task_id: 't-child', parent_id: '' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.equal(upd.params[8], null);
  assert.equal(upd.params[9], true, 'an explicit "" is still the caller mentioning parent_id');
});

test('update_task without parent_id leaves the existing parent untouched', async () => {
  // Stronger than it used to be. The old implementation re-wrote parent_id from
  // a row it had read moments earlier, so ANY unrelated update was a
  // read-modify-write that silently reverted a concurrent re-parent. Now the
  // guard is off and the SQL falls back to the row's OWN value at update time,
  // so the column is never touched. Assert the guard, not a copied value.
  const { db, res } = await callTask('update_task', { task_id: 't-child', status: 'done' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const update = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.equal(update.params[9], false, 'the guard must be OFF when the caller never mentions parent_id');
  assert.ok(update.n.includes('else parent_id end'), 'must fall back to the row\'s own parent_id');
});

test('a human login identity assigning through MCP durably owns the dispatch route', async () => {
  const db = makeDb();
  const dispatches = [];
  const { deps } = makeDeps({
    db,
    deps: {
      dispatchTaskAssignment: async (args) => { dispatches.push(args); },
    },
  });
  const handler = createMcpHandler(deps);
  const res = await call(handler, {
    token: 'user-token',
    body: rpc('tools/call', {
      name: 'update_task',
      arguments: { task_id: 't-child', assignee_id: 'agent-next' },
    }),
  });

  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const update = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.ok(update, 'the task assignment must be written');
  assert.ok(
    update.n.includes('when $14 and assignee_id is distinct from $7 then $15'),
    'requester changes only on a real assignee transition',
  );
  assert.equal(update.params[13], true, 'the caller explicitly assigned an agent');
  assert.equal(update.params[14], USER_IDENTITY.userId, 'the durable requester is the login identity');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(dispatches.length, 1);
  assert.equal(dispatches[0].actorUserId, USER_IDENTITY.userId);
});

test('update_task rejects self-parenting — before any update', async () => {
  const { db, res } = await callTask('update_task', { task_id: 't-child', parent_id: 't-child' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /cannot be its own parent/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task fails CLOSED when the parent chain is too deep to verify', async () => {
  // Regression: the cycle walk used to be `for (…; hops < MAX_TASK_DEPTH; …)`,
  // so hitting the cap fell out of the loop and returned the parent as valid.
  // A chain of 80 slipped through unchecked. Refusing is correct either way —
  // a real tree is never this deep, so reaching the cap means the table already
  // holds a cycle, and guessing wrong cascades a delete through a subtree.
  const { db, res } = await callTask('update_task', { task_id: 't-child', parent_id: 'deep-79' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /too deep to verify/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a cycle (parenting a task under its own descendant)', async () => {
  const { db, res } = await callTask('update_task', { task_id: 't-root', parent_id: 't-grand' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /cycle/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a cross-workspace parent — before any update', async () => {
  const { db, res } = await callTask('update_task', { task_id: 't-child', parent_id: 't-other' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /parent task not found in this workspace/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('list_tasks returns parent_id so an agent can rebuild the tree', async () => {
  const { res } = await callTask('list_tasks', {});
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const { tasks } = JSON.parse(res.body.result.content[0].text);
  const child = tasks.find((t) => t.id === 't-child');
  assert.equal(child.parent_id, 't-root');
  assert.ok(!tasks.some((t) => t.id === 't-other'), 'must not leak another workspace');
});

// --- Dates + dependencies (start_date / due_date / depends_on) --------------
// Before this, NOTHING wrote these three columns, so the Gantt had nothing to
// draw and every task collapsed to an identical marker at created_at. Agents
// are the main authors of task plans, so the MCP surface has to accept them —
// and has to refuse a cycle, because the timeline walks depends_on to lay out
// bars and a loop never terminates.

// Param positions in the update_task statement (1-indexed $n -> 0-indexed).
const U_DUE_DATE = 7;
const U_START_DATE = 10;
const U_DEPENDS_ON = 11;
const U_DEPENDS_GUARD = 12;

test('create_task and update_task expose start_date/due_date/depends_on in their schemas', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/list') });
  const byName = Object.fromEntries(res.body.result.tools.map((t) => [t.name, t]));
  for (const tool of ['create_task', 'update_task']) {
    const props = byName[tool].inputSchema.properties;
    assert.ok(props.start_date, `${tool} must accept start_date`);
    assert.ok(props.due_date, `${tool} must accept due_date`);
    assert.equal(props.depends_on.type, 'array', `${tool} depends_on must be an array`);
    assert.equal(props.depends_on.items.type, 'string', `${tool} depends_on items must be strings`);
  }
});

test('update_task writes start_date and due_date as normalized ISO', async () => {
  const { db, res } = await callTask('update_task', {
    task_id: 'd-a', start_date: '2026-08-03', due_date: '2026-08-07T00:00:00.000Z',
  });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.ok(upd.n.includes('start_date = coalesce($11, start_date)'), 'must set start_date');
  assert.equal(upd.params[U_START_DATE], new Date('2026-08-03').toISOString());
  assert.equal(upd.params[U_DUE_DATE], '2026-08-07T00:00:00.000Z');
});

test('update_task leaves both dates alone when the caller omits them', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', status: 'in_progress' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.equal(upd.params[U_START_DATE], null, 'null start_date => coalesce keeps the column');
  assert.equal(upd.params[U_DUE_DATE], null, 'null due_date => coalesce keeps the column');
});

test('update_task REJECTS an unparseable start_date before any write', async () => {
  // Passing it through would either store garbage or blow up mid-statement as
  // an opaque -32603. The caller gets told which argument is wrong instead.
  const { db, res } = await callTask('update_task', { task_id: 'd-a', start_date: 'next tuesday-ish' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /start_date is not a parseable date/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task REJECTS an unparseable due_date before any write', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', due_date: 'whenever' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /due_date is not a parseable date/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task sets depends_on as a PG array literal with a uuid[] cast', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-c', depends_on: ['d-a', 'd-b'] });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  // A raw JS array bound to an untyped $n serializes as `a,b`, not `{a,b}` —
  // postgres.js does not array-serialize through .unsafe().
  assert.ok(upd.n.includes('depends_on = case when $13 then $12::uuid[] else depends_on end'), 'must cast the literal to uuid[]');
  assert.equal(upd.params[U_DEPENDS_ON], '{"d-a","d-b"}');
  assert.equal(upd.params[U_DEPENDS_GUARD], true);
});

test('update_task with depends_on [] CLEARS the list (guard on, empty literal)', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-c', depends_on: [] });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.equal(upd.params[U_DEPENDS_ON], '{}');
  assert.equal(upd.params[U_DEPENDS_GUARD], true, 'an explicit [] is still the caller mentioning depends_on');
});

test('update_task without depends_on leaves the column untouched', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-c', status: 'done' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.equal(upd.params[U_DEPENDS_GUARD], false, 'the guard must be OFF when the caller never mentions depends_on');
  assert.ok(upd.n.includes('else depends_on end'), 'must fall back to the row\'s own depends_on');
});

test('update_task rejects a self-dependency before any write', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: ['d-a'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /cannot depend on itself/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a DIRECT 2-cycle (a<->b)', async () => {
  // d-b already depends on d-a, so d-a depending on d-b closes the loop.
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: ['d-b'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /cycle/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a TRANSITIVE cycle (a -> c where c -> b -> a)', async () => {
  // The interesting case: nothing about d-c mentions d-a directly, so a
  // one-hop check would wave this through and the layout would never terminate.
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: ['d-c'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /cycle/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a cycle even when it hides among legal dependencies', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: ['t-root', 'd-c'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /cycle/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task ACCEPTS a forward dependency that does not close a loop', async () => {
  // d-c -> d-a is redundant (already transitive through d-b) but not a cycle.
  const { db, res } = await callTask('update_task', { task_id: 'd-c', depends_on: ['d-a'] });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const upd = db.calls.find((c) => c.n.startsWith('update tasks set'));
  assert.equal(upd.params[U_DEPENDS_ON], '{"d-a"}');
});

test('update_task rejects a dependency in ANOTHER workspace before any write', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: ['t-other'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /dependency task not found in this workspace/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a dependency id that does not exist at all', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: ['d-nope'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /dependency task not found in this workspace/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a non-array depends_on', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: 'd-b' });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /depends_on must be an array/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('update_task rejects a depends_on entry that is not a string', async () => {
  const { db, res } = await callTask('update_task', { task_id: 'd-a', depends_on: [42] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /depends_on must contain task id strings/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('update tasks set')), 'must not reach the update');
});

test('create_task writes start_date and a depends_on array literal', async () => {
  const { db, res } = await callTask('create_task', {
    title: 'Step 4', start_date: '2026-08-10', due_date: '2026-08-12', depends_on: ['d-c'],
  });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into tasks'));
  assert.ok(insert.n.includes('start_date'), 'insert must name start_date');
  assert.ok(insert.n.includes('$11::uuid[]'), 'depends_on must be cast to uuid[]');
  assert.equal(insert.params[9], new Date('2026-08-10').toISOString());
  assert.equal(insert.params[10], '{"d-c"}');
});

test('create_task rejects a dependency outside the workspace before any insert', async () => {
  const { db, res } = await callTask('create_task', { title: 'Leaky', depends_on: ['t-other'] });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /dependency task not found in this workspace/i);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into tasks')), 'must not reach the insert');
});

test('create_task without depends_on writes an empty array, not a bare JS array', async () => {
  const { db, res } = await callTask('create_task', { title: 'Plain' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into tasks'));
  assert.equal(insert.params[10], '{}');
});

// --- create_channel reply timing --------------------------------------------
// conversation_mode used to be a column nothing read, so this tool's default of
// 'mention' was harmless. The dispatcher reads it again, which makes the default
// load-bearing: get it wrong and an agent-created channel silently answers
// nothing while a human-created one answers, with nothing on screen to say why.

test('create_channel defaults to auto, matching a channel created in the UI', async () => {
  const { db, res } = await callTask('create_channel', { title: 'ops' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into chat_sessions'));
  assert.ok(insert, 'must reach the insert');
  assert.equal(insert.params[3], 'auto');
});

test('create_channel honours an explicit mention mode', async () => {
  const { db, res } = await callTask('create_channel', { title: 'quiet', conversation_mode: 'mention' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into chat_sessions'));
  assert.equal(insert.params[3], 'mention');
});

test('create_channel normalizes an unrecognised mode to auto rather than storing it', async () => {
  // A stored value outside the enum would read as 'auto' anyway
  // (normalizeConversationMode), so writing it would leave the row disagreeing
  // with the behaviour it produces.
  const { db, res } = await callTask('create_channel', { title: 'odd', conversation_mode: 'whenever' });
  assert.ok(!res.body.result.isError, res.body.result?.content?.[0]?.text);
  const insert = db.calls.find((c) => c.n.startsWith('insert into chat_sessions'));
  assert.equal(insert.params[3], 'auto');
});

test('create_channel refuses folders reserved for private or derived conversations', async () => {
  for (const folder of ['Direct messages', 'huddle', 'sub-thread', ' DIRECT MESSAGES ']) {
    const { db, res } = await callTask('create_channel', { title: 'orphan attempt', folder });
    assert.equal(res.body.result.isError, true, folder);
    assert.match(res.body.result.content[0].text, /reserved for system-created conversations/i);
    assert.equal(
      db.calls.some((call) => call.n.startsWith('insert into chat_sessions')),
      false,
      `${folder} must be refused before insert`,
    );
  }
});
