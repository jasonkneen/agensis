const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../server/mcp.cjs');

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const AGENT = { kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder', agent: { model: 'claude-opus-4-8', description: 'coding agent' } };
const INVITE = { kind: 'invite', workspaceId: WS, inviteId: 'inv-1', name: 'cursor@x.com' };

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
      if (n.startsWith('insert into messages')) {
        messageSeq += 1;
        const row = { id: `m-${messageSeq}`, session_id: params[0], content: params[1], sender_kind: 'agent', sender_id: params[3], sender_name: params[4] };
        db.inserted.push(row);
        return [row];
      }
      if (n.startsWith('update chat_sessions set updated_at')) return [];
      return [];
    },
  };
  return db;
}

function makeDeps(overrides = {}) {
  const continueCalls = [];
  const notifyCalls = [];
  const tokenMap = overrides.tokenMap || { 'good-token': AGENT, 'invite-token': INVITE };
  const deps = {
    getDb: () => overrides.db,
    verifyMcpToken: async (token) => tokenMap[token] || null,
    continueConversation: async (arg) => { continueCalls.push(arg); },
    notifyDbSubscribers: (table, ev, rows) => { notifyCalls.push({ table, ev, rows }); },
    slugHandle: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
    claimMcpJob: async () => null,
    submitMcpJobResult: async () => ({ jobId: 'x', status: 'done' }),
    resolveWorkspaceAgentByHandle: async (_ws, handle) => (handle === 'coder' ? { id: 'agent-1', handle: 'coder', name: 'Coder' } : null),
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

test('post_message inserts + notifies but does NOT trigger continueConversation', async () => {
  const db = makeDb();
  const { deps, continueCalls, notifyCalls } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', {
    name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hello team' },
  }) });
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
  const res = await call(handler, { body: rpc('tools/call', {
    name: 'dispatch_agent', arguments: { channel_id: 'ch-1', content: '@scout find the bug' },
  }) });
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
  const res = await call(handler, { body: rpc('tools/call', {
    name: 'read_channel', arguments: { channel_id: 'ch-x' },
  }) });
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
  const res = await call(handler, { body: [
    rpc('initialize', {}, 1),
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    rpc('tools/list', {}, 2),
  ] });
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

test('an invite client cannot post_message (agent-only)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'invite-token', body: rpc('tools/call', { name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hi' } }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not available for a invite token/i);
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
