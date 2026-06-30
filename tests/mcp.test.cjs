const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../server/mcp.cjs');

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const AGENT = { kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder', agent: { model: 'claude-opus-4-8', description: 'coding agent' } };
const RUNTIME = { kind: 'runtime', runtimeId: 'rt-1', workspaceId: WS, name: 'Cursor', status: 'approved' };
const RUNTIME_PENDING = { kind: 'runtime', runtimeId: 'rt-2', workspaceId: WS, name: 'Pending', status: 'pending' };
const JOIN = { kind: 'join', workspaceId: WS, autoApprove: false };

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
  // Token → identity map. 'good-token' = agent; 'rt-token' = approved runtime;
  // 'rt-pending' = pending runtime; 'join-token' = workspace join. Override per test.
  const tokenMap = overrides.tokenMap || {
    'good-token': AGENT,
    'rt-token': RUNTIME,
    'rt-pending': RUNTIME_PENDING,
    'join-token': JOIN,
  };
  const deps = {
    getDb: () => overrides.db,
    verifyMcpToken: async (token) => tokenMap[token] || null,
    continueConversation: async (arg) => { continueCalls.push(arg); },
    notifyDbSubscribers: (table, ev, rows) => { notifyCalls.push({ table, ev, rows }); },
    slugHandle: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
    claimExternalJob: async () => null,
    submitExternalJobResult: async () => ({ jobId: 'x', status: 'done' }),
    externalAgentIdsForRuntime: async () => ['agent-1', 'agent-2'],
    registerRuntime: async () => ({ runtime: { id: 'rt-new', status: 'pending' }, token: 'agr_minted' }),
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
    'claim_job', 'submit_job_result', 'fail_job',
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

test('claim_job scopes the claim to the authenticated agent and returns {job:null} when idle', async () => {
  const db = makeDb();
  const claimCalls = [];
  const { deps } = makeDeps({ db, deps: {
    claimExternalJob: async (arg) => { claimCalls.push(arg); return null; },
  } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'claim_job', arguments: {} }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.deepEqual(payload, { job: null });
  assert.equal(claimCalls.length, 1);
  assert.equal(claimCalls[0].workspaceId, WS);
  assert.deepEqual(claimCalls[0].agentIds, ['agent-1'], 'per-agent token claims only its own agent');
});

test('claim_job returns the claimed job payload', async () => {
  const db = makeDb();
  const job = { jobId: 'job-9', prompt: 'answer this', sessionId: 'ch-1', threadParentId: null, agent: { handle: 'coder' } };
  const { deps } = makeDeps({ db, deps: { claimExternalJob: async () => job } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'claim_job', arguments: {} }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.job.jobId, 'job-9');
  assert.equal(payload.job.prompt, 'answer this');
});

test('submit_job_result forwards workspace, jobId, response and agent scope', async () => {
  const db = makeDb();
  const submitCalls = [];
  const { deps } = makeDeps({ db, deps: {
    submitExternalJobResult: async (arg) => { submitCalls.push(arg); return { jobId: arg.jobId, status: 'done' }; },
  } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', {
    name: 'submit_job_result', arguments: { job_id: 'job-9', response: 'here is the answer' },
  }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.status, 'done');
  assert.equal(submitCalls.length, 1);
  assert.deepEqual(submitCalls[0], { workspaceId: WS, jobId: 'job-9', responseText: 'here is the answer', agentIds: ['agent-1'], runtimeId: null });
});

test('fail_job forwards an errorText (not a response)', async () => {
  const db = makeDb();
  const submitCalls = [];
  const { deps } = makeDeps({ db, deps: {
    submitExternalJobResult: async (arg) => { submitCalls.push(arg); return { jobId: arg.jobId, status: 'error' }; },
  } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', {
    name: 'fail_job', arguments: { job_id: 'job-9', error: 'model timed out' },
  }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.status, 'error');
  assert.equal(submitCalls[0].errorText, 'model timed out');
  assert.equal(submitCalls[0].responseText, undefined);
});

test('submit_job_result surfaces a clean tool error when the job is not claimable', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db, deps: {
    submitExternalJobResult: async () => { throw new Error('Job is done, not awaiting a result'); },
  } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', {
    name: 'submit_job_result', arguments: { job_id: 'job-9', response: 'late' },
  }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not awaiting a result/i);
});

test('tools/list exposes register_runtime', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/list') });
  const names = res.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('register_runtime'));
});

test('whoami reports kind=agent for an agent token', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'whoami', arguments: {} }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.kind, 'agent');
  assert.equal(payload.agentId, 'agent-1');
});

test('whoami reports kind=runtime + status for a runtime token', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'rt-token', body: rpc('tools/call', { name: 'whoami', arguments: {} }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.kind, 'runtime');
  assert.equal(payload.runtimeId, 'rt-1');
  assert.equal(payload.status, 'approved');
});

test('whoami reports kind=join for a join token', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'join-token', body: rpc('tools/call', { name: 'whoami', arguments: {} }) });
  const payload = JSON.parse(res.body.result.content[0].text);
  assert.equal(payload.kind, 'join');
  assert.equal(payload.workspaceId, WS);
});

test('a join token can register_runtime but cannot claim_job', async () => {
  const db = makeDb();
  const registerCalls = [];
  const { deps } = makeDeps({ db, deps: {
    registerRuntime: async (arg) => { registerCalls.push(arg); return { runtime: { id: 'rt-new', status: 'pending' }, token: 'agr_minted' }; },
  } });
  const handler = createMcpHandler(deps);

  const reg = await call(handler, { token: 'join-token', body: rpc('tools/call', {
    name: 'register_runtime', arguments: { name: 'Cursor (GPT-5.5)' },
  }) });
  const payload = JSON.parse(reg.body.result.content[0].text);
  assert.equal(payload.token, 'agr_minted');
  assert.equal(payload.status, 'pending');
  assert.equal(registerCalls[0].name, 'Cursor (GPT-5.5)');

  const claim = await call(handler, { token: 'join-token', body: rpc('tools/call', { name: 'claim_job', arguments: {} }) });
  assert.equal(claim.body.result.isError, true);
  assert.match(claim.body.result.content[0].text, /not available for a join token/i);
});

test('a runtime token cannot post_message (agent-only tool)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'rt-token', body: rpc('tools/call', {
    name: 'post_message', arguments: { channel_id: 'ch-1', content: 'hi' },
  }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not available for a runtime token/i);
});

test('an agent token cannot register_runtime (join-only tool)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'register_runtime', arguments: {} }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not available for an? agent token/i);
});

test('runtime claim_job resolves its mapped agents and passes runtimeId', async () => {
  const db = makeDb();
  const claimCalls = [];
  const { deps } = makeDeps({ db, deps: {
    externalAgentIdsForRuntime: async (rid, only) => { claimCalls.push({ rid, only }); return ['agent-1', 'agent-2']; },
    claimExternalJob: async (arg) => { claimCalls.push(arg); return null; },
  } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'rt-token', body: rpc('tools/call', {
    name: 'claim_job', arguments: { only: ['coder'] },
  }) });
  assert.deepEqual(JSON.parse(res.body.result.content[0].text), { job: null });
  assert.deepEqual(claimCalls[0], { rid: 'rt-1', only: ['coder'] });
  assert.equal(claimCalls[1].runtimeId, 'rt-1');
  assert.deepEqual(claimCalls[1].agentIds, ['agent-1', 'agent-2']);
});

test('a pending runtime is refused at claim_job with a clear message', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'rt-pending', body: rpc('tools/call', { name: 'claim_job', arguments: {} }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /pending approval/i);
});

test('runtime submit_job_result forwards mapped agentIds + runtimeId', async () => {
  const db = makeDb();
  const submitCalls = [];
  const { deps } = makeDeps({ db, deps: {
    externalAgentIdsForRuntime: async () => ['agent-1', 'agent-2'],
    submitExternalJobResult: async (arg) => { submitCalls.push(arg); return { jobId: arg.jobId, status: 'done' }; },
  } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'rt-token', body: rpc('tools/call', {
    name: 'submit_job_result', arguments: { job_id: 'job-9', response: 'done' },
  }) });
  assert.equal(JSON.parse(res.body.result.content[0].text).status, 'done');
  assert.deepEqual(submitCalls[0].agentIds, ['agent-1', 'agent-2']);
  assert.equal(submitCalls[0].runtimeId, 'rt-1');
});

test('notifications get no response (202)', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.ended, true);
});

test('register_runtime surfaces a tool error when minting fails', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db, deps: { registerRuntime: async () => { throw new Error('insert failed'); } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { token: 'join-token', body: rpc('tools/call', { name: 'register_runtime', arguments: {} }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /insert failed/i);
});

test('fail_job surfaces a tool error when the submit dep throws', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db, deps: { submitExternalJobResult: async () => { throw new Error('db gone'); } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'fail_job', arguments: { job_id: 'j', error: 'x' } }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /db gone/i);
});

test('an unexpected auth-layer throw becomes a JSON-RPC -32603', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db, deps: { verifyMcpToken: async () => { throw new Error('auth subsystem down'); } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/list') });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.error.code, -32603);
});

test('ping, resources/list and prompts/list return their canonical shapes', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  assert.deepEqual((await call(handler, { body: rpc('ping') })).body.result, {});
  assert.deepEqual((await call(handler, { body: rpc('resources/list') })).body.result, { resources: [] });
  assert.deepEqual((await call(handler, { body: rpc('prompts/list') })).body.result, { prompts: [] });
});

test('a malformed JSON-RPC request returns -32600', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: { id: 1, method: 'tools/list' } }); // missing jsonrpc: '2.0'
  assert.equal(res.body.error.code, -32600);
});

test('a tool that throws a non-ToolError surfaces an internal-error result', async () => {
  // getDb throws → list_channels.run rejects with a plain Error → handler -32603 path.
  const { deps } = makeDeps({ db: null, deps: { getDb: () => { throw new Error('db down'); } } });
  const handler = createMcpHandler(deps);
  const res = await call(handler, { body: rpc('tools/call', { name: 'list_channels', arguments: {} }) });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /Internal error executing list_channels/i);
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
