const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../server/mcp.cjs');
const { __test } = require('../server/index.cjs');
const { roleHasWorkspaceCapability } = __test;

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const AGENT = { kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder', agent: { model: 'claude-opus-4-8', description: 'coding agent' } };
const INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-1', name: 'cursor@x.com', autoApprove: true, role: 'editor' };
const VIEWER_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-viewer', name: 'viewer@x.com', autoApprove: true, role: 'viewer' };
const COMMENTER_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-commenter', name: 'commenter@x.com', autoApprove: true, role: 'commenter' };
const EDITOR_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-editor', name: 'editor@x.com', autoApprove: true, role: 'editor' };
const ADMIN_INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-admin', name: 'admin@x.com', autoApprove: true, role: 'admin' };
const WORKSPACE = { kind: 'workspace', workspaceId: WS, name: 'MCP client', autoApprove: false };
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
const TASK_ROWS = {
  't-root': { id: 't-root', workspace_id: WS, parent_id: null, title: 'Root' },
  't-child': { id: 't-child', workspace_id: WS, parent_id: 't-root', title: 'Child' },
  't-grand': { id: 't-grand', workspace_id: WS, parent_id: 't-child', title: 'Grandchild' },
  't-other': { id: 't-other', workspace_id: OTHER_WS, parent_id: null, title: 'Foreign' },
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
      if (n.startsWith('insert into messages')) {
        messageSeq += 1;
        const row = { id: `m-${messageSeq}`, session_id: params[0], content: params[1], sender_kind: params[3], sender_id: params[4], sender_name: params[5] };
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
    'viewer-invite-token': VIEWER_INVITE,
    'commenter-invite-token': COMMENTER_INVITE,
    'editor-invite-token': EDITOR_INVITE,
    'admin-invite-token': ADMIN_INVITE,
    'flow-token': FLOW_CHANNEL,
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
