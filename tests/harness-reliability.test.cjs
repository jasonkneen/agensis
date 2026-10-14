'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readAnthropicStream } = require('../server/anthropic-stream.cjs');
const { createBuiltinTurn } = require('../server/builtin-turn.cjs');
const { commitJobOutcome } = require('../server/job-finalization.cjs');
const { createAnthropicUsageAccumulator } = require('../shared/usage-metering.cjs');
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const start = { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'write', input: {} } };
const end = reason => event({ type: 'message_delta', delta: { stop_reason: reason } }) + event({ type: 'message_stop' });
const read = body => readAnthropicStream(new Response(body).body, { usage: createAnthropicUsageAccumulator() });

test('cut/error provider streams never return executable tools', async () => {
 for (const body of ['', event(start), event(start) + event({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{}' } }), event({ type: 'error', error: { type: 'overloaded_error' } })]) {
  await assert.rejects(read(body), { code: 'anthropic_stream_failed' });
 }
});
test('final SSE block without a delimiter is consumed; complete empty arguments are valid', async () => {
 const result = await read((event(start) + event({ type: 'content_block_stop', index: 0 }) + end('tool_use')).trimEnd());
 assert.deepEqual(result.toolUses[0].input, {});
});
test('partial text survives a malformed trailing frame', async () => {
 const body = event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } })
  + event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial answer' } }) + 'data: {cut';
 await assert.rejects(read(body), error => error.partialText === 'partial answer');
});
test('keepalive traffic cannot extend the body idle deadline', async () => {
 let stopped = false;
 const body = { [Symbol.asyncIterator]() { return {
  next: async () => { await new Promise(resolve => setTimeout(resolve, 2)); return { value: Buffer.from(': ping\n\n'), done: stopped }; },
  return: async () => { stopped = true; return { done: true }; },
 }; } };
 await assert.rejects(readAnthropicStream(body, { usage: createAnthropicUsageAccumulator(), idleMs: 15 }), /idle_timeout/);
});
test('transport error and abort both record observed usage exactly once', async () => {
 for (const cancel of [false, true]) {
  const calls = [];
  const controller = new AbortController();
  const turn = createBuiltinTurn({
   getDb: () => ({}), recordAudit() {}, drainAgentTaskQueue() {}, drainPendingChatTurn() {}, enforceWorkspaceRole() {},
   getAnthropicApiKey: async () => 'fixture', resolveAnthropicModel: value => value, buildSystemPrompt: () => '',
   createAnthropicUsageAccumulator, recordAnthropicUsage: async (_, value) => calls.push(value),
   anthropicFetch: async () => ({ ok: true, body: (async function* () {
    yield Buffer.from(event({ type: 'message_start', message: { usage: { input_tokens: 12, cache_read_input_tokens: 4 } } }));
    if (cancel) controller.abort(new Error('user cancelled'));
    throw new Error('socket reset');
   })() }),
  });
  await assert.rejects(turn.streamAnthropicTurn({ model: 'fixture', messages: [], signal: controller.signal }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].counts.inputUnits, 12);
  assert.equal(calls[0].counts.cacheReadUnits, 4);
 }
});
test('transaction rolls back job success when required output fails', async () => {
 let record = { id: 'job', status: 'running' };
 const db = {
  begin: async work => { const snapshot = { ...record }; try { return await work({}); } catch (error) { record = snapshot; throw error; } },
  unsafe: async () => [record],
 };
 await assert.rejects(commitJobOutcome(db, { id: 'job', status: 'done', field: 'response', value: 'answer' }, async () => {
  record = { id: 'job', status: 'done', response: 'answer' };
  throw new Error('transcript failed');
 }), { code: 'agent_job_finalization_failed' });
 assert.equal(record.status, 'running');
});
test('lost commit acknowledgment is reconciled from the exact durable job', async () => {
 let record;
 const db = { begin: async work => { await work({}); throw new Error('lost commit reply'); }, unsafe: async (_, args) => { assert.deepEqual(args, ['job']); return [record]; } };
 const result = await commitJobOutcome(db, { id: 'job', status: 'done', field: 'response', value: 'answer' }, async () => {
  record = { id: 'job', status: 'done', response: 'answer' }; return 'committed transcript';
 });
 assert.equal(result, 'committed transcript');
});
test('unknown commit and failed readback remain explicit finalization failures', async () => {
 const db = { begin: async () => { throw new Error('timeout'); }, unsafe: async () => { throw new Error('offline'); } };
 await assert.rejects(commitJobOutcome(db, { id: 'job' }, async () => {}), error => error.code === 'agent_job_finalization_failed' && error.outcome === 'unknown');
});

test('desktop shutdown waits for escalation even after SIGTERM sets killed=true', async () => {
 const fs = require('node:fs');
 const vm = require('node:vm');
 const { createRequire } = require('node:module');
 const { EventEmitter } = require('node:events');
 const filename = require.resolve('../electron/local-runtime/supervisor.cjs');
 const callbacks = [], kills = [];
 const child = new EventEmitter();
 Object.assign(child, { exitCode: null, signalCode: null, killed: false, kill(signal) { kills.push(signal); this.killed = true; } });
 const module = { exports: {} };
 vm.runInNewContext(fs.readFileSync(filename, 'utf8') + '\nmodule.exports.seed = child => sessions.set("fixture", { child });', {
  require: createRequire(filename), module, console, process,
  setTimeout: fn => { callbacks.push(fn); return {}; }, clearTimeout() {},
 });
 module.exports.seed(child);
 let stopped = false;
 const pending = module.exports.stopAll().then(() => { stopped = true; });
 await Promise.resolve();
 assert.equal(stopped, false);
 assert.deepEqual(kills, ['SIGTERM']);
 callbacks.forEach(fn => fn());
 await pending;
 assert.deepEqual(kills, ['SIGTERM', 'SIGKILL']);
});

function lifecycleFixture() {
 let state = 'running', failTranscript = false, provider;
 let toolCalls = 0, drains = 0, finalWrites = 0;
 const db = {
  async begin(work) { const before = state; try { return await work(db); } catch (error) { state = before; throw error; } },
  async unsafe(sql, params) {
   if (/select status from agent_jobs/.test(sql)) return [{ status: state }];
   if (/select \* from agent_jobs/.test(sql)) return [{ id: 'job', status: state }];
   if (/update agent_jobs set status = '(done|error)'/.test(sql)) {
    if (state !== 'running') return [];
    state = /status = 'done'/.test(sql) ? 'done' : 'error';
    return [{ id: 'job', status: state }];
   }
   if (/update messages\s+set content = \$2, broadcast_to_channel/.test(sql)) {
    finalWrites++;
    if (failTranscript) throw new Error('transcript rejected');
    return [{ id: 'message' }];
   }
   if (/insert into messages/.test(sql)) return [{ id: params[0] }];
   return [];
  },
 };
 const noop = () => {};
 const turn = createBuiltinTurn({ recordAudit: noop, drainAgentTaskQueue: noop, drainPendingChatTurn: noop, enforceWorkspaceRole: noop,
  getDb: () => db, isAgentEnabled: () => true, slugHandle: x => x, resolveRunTarget: () => 'builtin',
  buildAgentTurnContextSnapshot: async () => ({ messages: [{ role: 'user', content: 'fixture' }], lastSeenMessageId: null }),
  resolveWorkThreadParent: async () => ({ parentId: null, broadcast: true }), agentContextFromRow: () => ({ systemPrompt: '' }),
  buildAgentActivityDigest: async () => '', sessionHasLiveHuddle: async () => false, loadChannelIntentNote: async () => '',
  loadSandboxSkillNote: async () => '', hasMcpPresence: () => false, insertActiveAgentJob: async () => [{ id: 'job' }],
  notifyDbSubscribers: noop, createBuiltinToolset: () => ({ specs: () => [{ name: 'write' }], call: async () => { toolCalls++; return { ok: true, value: null }; } }),
  agentStepParts: x => x, agentStepContent: () => 'tool', formatElapsedMs: () => '1s', agentRuntimePayload: () => ({}),
  scheduleTaskQueueDrain: () => drains++, getAnthropicApiKey: async () => 'fixture', resolveAnthropicModel: x => x,
  buildSystemPrompt: () => '', createAnthropicUsageAccumulator, recordAnthropicUsage: async () => {},
  anthropicFetch: request => provider(request),
 });
 return { turn, db, setProvider: fn => { provider = fn; }, failTranscript: () => { failTranscript = true; },
  state: () => state, toolCalls: () => toolCalls, drains: () => drains, finalWrites: () => finalWrites,
  run: () => turn.runAgentTurn({ id: 'agent', workspace_id: 'workspace', name: 'fixture' }, { workspaceId: 'workspace', sessionId: 'session' }),
 };
}
test('real builtin lifecycle does not complete or drain if final transcript write fails', async () => {
 const fixture = lifecycleFixture();
 fixture.failTranscript();
 fixture.setProvider(async () => new Response(event({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) + event({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'answer' } }) + event({ type: 'content_block_stop', index: 0 }) + end('end_turn')));
 await assert.rejects(fixture.run(), { code: 'agent_job_finalization_failed' });
 assert.equal(fixture.finalWrites(), 1);
 assert.equal(fixture.state(), 'running');
 assert.equal(fixture.drains(), 0);
});
test('reaping a builtin aborts its request and rejects late tool work', async () => {
 const fixture = lifecycleFixture();
 let entered, release, signal;
 const started = new Promise(resolve => { entered = resolve; });
 fixture.setProvider(request => { signal = request.signal; entered(); return new Promise(resolve => { release = resolve; }); });
 const pending = fixture.run();
 await started;
 const { createAgentJobs } = require('../server/agent-jobs.cjs');
 const jobs = createAgentJobs({ getDb: () => fixture.db, parseJsonObject: x => x || {}, notifyDbSubscribers() {},
  scheduleTaskQueueDrain() {}, drainPendingChatTurn() {}, cancelBuiltinJob: fixture.turn.cancelBuiltinJob });
 await jobs.finalizeStuckJob({ id: 'job', workspace_id: 'workspace', session_id: 'session', agent_id: 'agent', metadata: { mode: 'builtin' } }, 'timeout', 'idle_timeout');
 assert.equal(signal.aborted, true);
 release(new Response(event(start) + event({ type: 'content_block_stop', index: 0 }) + end('tool_use')));
 await pending;
 assert.equal(fixture.state(), 'error');
 assert.equal(fixture.toolCalls(), 0);
});

test('finalizeAgentJobResult treats non-completed stopReason with empty output as error and notifies parent dispatcher', async () => {
 const { createAgentJobs } = require('../server/agent-jobs.cjs');
 const jobUpdates = [];
 const parentMessages = [];
 const db = {
  async unsafe(sql, params) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim();
   if (normalized.startsWith('update agent_jobs set status = $2')) {
    jobUpdates.push({ status: params[1], response: params[2], error: params[3], metadata: params[4] });
    return [{ id: params[0], status: params[1], metadata: params[4] }];
   }
   if (normalized.startsWith('insert into messages (session_id, role, content, sender_kind, sender_name)')) {
    parentMessages.push(params[1]);
    return [{ id: 'sys-msg-1', content: params[1] }];
   }
   if (normalized.includes('from messages')) return [{ id: 'msg-1' }];
   if (normalized.includes('update messages') || normalized.includes('insert into messages')) return [{ id: 'msg-1' }];
   return [];
  },
 };
 const jobs = createAgentJobs({
  getDb: () => db,
  parseJsonObject: value => (value && typeof value === 'object' ? value : {}),
  textFromValue: value => String(value || ''),
  slugHandle: value => String(value || 'agent').toLowerCase(),
  notifyDbSubscribers() {},
  scheduleTaskQueueDrain() {},
  drainAgentTaskQueue: async () => {},
  drainPendingChatTurn: async () => {},
  settleCapturedChatTask: async () => {},
  logMessageActivity: async () => {},
  mirrorAgentReplyToTaskComment: async () => {},
  continueConversation: async () => {},
  PLACEHOLDER_CONTENT_RE: '^Thinking( [0-9]|…)',
 });

 await jobs.finalizeAgentJobResult(
  {
   id: 'child-job-1',
   workspace_id: 'ws-1',
   session_id: 'child-sess-1',
   agent_id: 'agent-1',
   agent_name: 'Coder',
   agent_handle: 'coder',
   metadata: {
    handle: 'coder',
    responseMessageId: 'msg-1',
    dispatchedBy: { agentId: 'parent-1', sessionId: 'parent-sess-1', jobId: 'parent-job-1' },
   },
  },
  {
   responseText: '',
   errorText: '',
   resultStop: { stopReason: 'max_turns' },
  },
 );

 assert.equal(jobUpdates.length, 1);
 assert.equal(jobUpdates[0].status, 'error', 'max_turns with no output must not be marked done');
 assert.match(jobUpdates[0].error, /allowed steps for one turn/);
 assert.equal(parentMessages.length, 1, 'parent session must receive [child-failure] notice');
 assert.match(parentMessages[0], /^\[child-failure:child-job-1\] @coder ended with status error:/);
});

test('finalizeAgentJobResult with partial output and max_turns notifies parent dispatcher of incomplete stopReason', async () => {
 const { createAgentJobs } = require('../server/agent-jobs.cjs');
 const parentMessages = [];
 const db = {
  async unsafe(sql, params) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim();
   if (normalized.startsWith('update agent_jobs set status = $2')) {
    return [{ id: params[0], status: params[1], metadata: params[4] }];
   }
   if (normalized.startsWith('insert into messages (session_id, role, content, sender_kind, sender_name)')) {
    parentMessages.push(params[1]);
    return [{ id: 'sys-msg-2', content: params[1] }];
   }
   if (normalized.includes('update messages') || normalized.includes('insert into messages')) return [{ id: 'msg-1' }];
   return [];
  },
 };
 const jobs = createAgentJobs({
  getDb: () => db,
  parseJsonObject: value => (value && typeof value === 'object' ? value : {}),
  textFromValue: value => String(value || ''),
  slugHandle: value => String(value || 'agent').toLowerCase(),
  notifyDbSubscribers() {},
  scheduleTaskQueueDrain() {},
  drainAgentTaskQueue: async () => {},
  drainPendingChatTurn: async () => {},
  settleCapturedChatTask: async () => {},
  logMessageActivity: async () => {},
  mirrorAgentReplyToTaskComment: async () => {},
  continueConversation: async () => {},
  PLACEHOLDER_CONTENT_RE: '^Thinking( [0-9]|…)',
 });

 await jobs.finalizeAgentJobResult(
  {
   id: 'child-job-2',
   workspace_id: 'ws-1',
   session_id: 'child-sess-1',
   agent_id: 'agent-1',
   agent_name: 'Coder',
   agent_handle: 'coder',
   metadata: {
    handle: 'coder',
    responseMessageId: 'msg-1',
    dispatchedBy: { agentId: 'parent-1', sessionId: 'parent-sess-1', jobId: 'parent-job-1' },
   },
  },
  {
   responseText: 'Partial work before hitting step cap.',
   errorText: '',
   resultStop: { stopReason: 'max_turns' },
  },
 );

 assert.equal(parentMessages.length, 1, 'parent session must be notified even when partial text was produced');
 assert.match(parentMessages[0], /^\[child-failure:child-job-2\] @coder ended with status max_turns:/);
});

test('builtin turn failure drains pending chat turn and notifies parent dispatcher', async () => {
 const drainedChat = [];
 const parentNotices = [];
 let state = 'running';
 const db = {
  async begin(work) { return work(db); },
  async unsafe(sql, params) {
   if (/select status from agent_jobs/.test(sql)) return [{ status: state }];
   if (/update agent_jobs set status = 'error'/.test(sql)) {
    state = 'error';
    return [{ id: 'job-err-1', status: 'error' }];
   }
   if (/update messages|insert into messages/.test(sql)) return [{ id: params[0] || 'msg-1' }];
   return [];
  },
 };
 const noop = () => {};
 const jobRow = {
  id: 'job-err-1',
  workspace_id: 'ws-1',
  session_id: 'sess-1',
  agent_id: 'agent-1',
  metadata: {
   handle: 'scout',
   dispatchedBy: { agentId: 'parent-1', sessionId: 'parent-sess-1', jobId: 'parent-job-1' },
  },
 };
 const turn = createBuiltinTurn({
  recordAudit: noop,
  drainAgentTaskQueue: noop,
  drainPendingChatTurn: (sessionId, agentId, cause) => { drainedChat.push({ sessionId, agentId, cause }); },
  notifyDispatcherOfFailure: (row, info) => { parentNotices.push({ id: row.id, ...info }); },
  enforceWorkspaceRole: noop,
  getDb: () => db,
  isAgentEnabled: () => true,
  slugHandle: x => x,
  resolveRunTarget: () => 'builtin',
  buildAgentTurnContextSnapshot: async () => ({ messages: [{ role: 'user', content: 'hi' }], lastSeenMessageId: null }),
  resolveWorkThreadParent: async () => ({ parentId: null, broadcast: true }),
  agentContextFromRow: () => ({ systemPrompt: '' }),
  buildAgentActivityDigest: async () => '',
  sessionHasLiveHuddle: async () => false,
  loadChannelIntentNote: async () => '',
  loadSandboxSkillNote: async () => '',
  hasMcpPresence: () => false,
  insertActiveAgentJob: async () => [jobRow],
  notifyDbSubscribers: noop,
  createBuiltinToolset: () => ({ specs: () => [], call: async () => ({ ok: true, value: '' }) }),
  agentStepParts: x => x,
  agentStepContent: () => 'tool',
  formatElapsedMs: () => '1s',
  agentRuntimePayload: () => ({}),
  scheduleTaskQueueDrain: noop,
  getAnthropicApiKey: async () => 'fixture',
  resolveAnthropicModel: x => x,
  buildSystemPrompt: () => '',
  createAnthropicUsageAccumulator,
  recordAnthropicUsage: async () => {},
  anthropicFetch: async () => { throw new Error('provider down'); },
 });

 const result = await turn.runAgentTurn(
  { id: 'agent-1', workspace_id: 'ws-1', name: 'Scout', handle: 'scout' },
  { workspaceId: 'ws-1', sessionId: 'sess-1' },
 );
 assert.equal(result.ok, false);
 assert.equal(drainedChat.length, 1);
 assert.equal(drainedChat[0].cause, 'builtin_error');
 assert.equal(parentNotices.length, 1);
 assert.equal(parentNotices[0].id, 'job-err-1');
 assert.match(parentNotices[0].reason, /provider down/);
});

test('ai-chat route enforces upstream stream idle timeout and finalizes reserved placeholder', async () => {
 const { mountAiChatRoutes } = require('../server/ai-chat-routes.cjs');
 let handler = null;
 const app = {
  post(path, _auth, fn) {
   if (path === '/backend/ai-chat') handler = fn;
  },
 };
 mountAiChatRoutes(app, {
  requireAuth: (_req, _res, next) => next(),
  jsonError: (res, status, error) => res.status(status).json({ error: error?.message }),
  enforceWorkspaceRole: async () => {},
  dbRateLimitBlocked: async () => false,
  clientIpFromReq: () => '127.0.0.1',
  aiChatRateLimiter: {},
  aiChatDbRateLimiter: {},
  dbQuery: async () => [],
  inferenceBroker: {},
  liveSharedModelRoutes: async () => [],
  bindInferenceAbort: () => {},
  getAnthropicApiKey: async () => 'test-key',
  resolveAnthropicModel: m => m || 'claude-sonnet-4-6',
  buildSystemPrompt: () => '',
  normalizeAiChatMessages: msgs => ({ ok: true, messages: msgs || [{ role: 'user', content: 'hi' }] }),
  assertSafeOutboundUrl: async () => {},
  guardedFetchAgent: () => undefined,
  resolveGatewayRoute: async () => ({
   id: 'gw-1',
   name: 'Stalled Gateway',
   baseUrl: 'https://gateway.example.com/v1',
   model: 'gpt-test',
   apiKey: 'secret',
   headers: {},
  }),
  emitBridgeOutbound: async () => {},
  recordAnthropicUsage: async () => {},
  createAnthropicUsageAccumulator,
  enforceSessionRead: async () => {},
  sessionReadableSql: () => 'true',
  getDb: () => ({ unsafe: async () => [] }),
  notifyDbSubscribers: () => {},
  logMessageActivity: async () => {},
  parseJsonArray: () => [],
  aiStreamErrorText: () => '',
  upstreamConnectTimeoutMs: 50,
  upstreamIdleTimeoutMs: 25,
 });

 const originalFetch = global.fetch;
 global.fetch = async (_url, options) => ({
  ok: true,
  status: 200,
  body: {
   [Symbol.asyncIterator]() {
    return {
     next: () => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => {
       reject(options.signal.reason || new Error('aborted'));
      });
     }),
    };
   },
  },
 });
 try {
  const chunks = [];
  const res = {
   headersSent: false,
   statusCode: 200,
   setHeader() {},
   write(chunk) {
    this.headersSent = true;
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
   },
   end() {},
   status(code) { this.statusCode = code; return this; },
   json(payload) { this.body = payload; return this; },
  };
  await handler({
   userId: 'user-1',
   body: {
    workspaceId: 'ws-1',
    model: 'gateway:gw-1',
    messages: [{ role: 'user', content: 'hello' }],
   },
  }, res);
  assert.equal(res.statusCode, 504);
  assert.match(res.body?.error || '', /timed out/i);
 } finally {
  global.fetch = originalFetch;
 }
});

test('cancelFarmAgentJob expires pending permission requests and notifies parent dispatcher', async () => {
 const { createAgentJobs } = require('../server/agent-jobs.cjs');
 const expiredRows = [];
 const parentNotices = [];
 const sent = [];
 const connWs = { readyState: 1 };
 const connectedAgents = new Map([
  ['conn-farm-1', { connectionId: 'conn-farm-1', workspaceId: 'ws-farm', agentId: 'agent-farm', ws: connWs }],
 ]);
 const db = {
  async unsafe(sql, params = []) {
   if (/select \* from agent_jobs where id = \$1/.test(sql)) {
    return [{
     id: 'job-farm-1',
     workspace_id: 'ws-farm',
     agent_id: 'agent-farm',
     connection_id: 'conn-farm-1',
     session_id: 'sess-farm-1',
     status: 'running',
     metadata: {
      mode: 'farm',
      handle: 'farmer',
      dispatchedBy: { agentId: 'parent-1', sessionId: 'parent-sess-1', jobId: 'parent-job-1' },
     },
    }];
   }
   if (/update agent_jobs set status = 'cancelled'/.test(sql)) {
    return [{
     id: 'job-farm-1',
     workspace_id: 'ws-farm',
     agent_id: 'agent-farm',
     connection_id: 'conn-farm-1',
     session_id: 'sess-farm-1',
     status: 'cancelled',
     error: 'Cancelled by Farm',
     metadata: {
      mode: 'farm',
      handle: 'farmer',
      dispatchedBy: { agentId: 'parent-1', sessionId: 'parent-sess-1', jobId: 'parent-job-1' },
     },
    }];
   }
   if (/update agent_permission_requests/.test(sql)) {
    const row = {
     id: 'perm-farm-1',
     job_id: 'job-farm-1',
     workspace_id: 'ws-farm',
     session_id: 'sess-farm-1',
     connection_id: 'conn-farm-1',
     status: 'expired',
    };
    expiredRows.push(row);
    return [row];
   }
   if (/insert into messages[\s\S]*child-failure/.test(sql) || (params[1] && String(params[1]).includes('[child-failure:'))) {
    parentNotices.push({ sessionId: params[0], content: params[1] });
    return [{ id: 'msg-parent-1', session_id: params[0], content: params[1] }];
   }
   return [];
  },
 };
 const jobs = createAgentJobs({
  getDb: () => db,
  parseJsonObject: value => (value && typeof value === 'object' ? value : {}),
  textFromValue: value => String(value || ''),
  slugHandle: value => String(value || 'agent').toLowerCase(),
  notifyDbSubscribers() {},
  scheduleTaskQueueDrain() {},
  drainAgentTaskQueue: async () => {},
  drainPendingChatTurn: async () => {},
  settleCapturedChatTask: async () => {},
  logMessageActivity: async () => {},
  mirrorAgentReplyToTaskComment: async () => {},
  continueConversation: async () => {},
  getConnectedAgents: () => connectedAgents,
  findConnectedAgent: () => null,
  sendWs: (_ws, payload) => { sent.push(payload); return true; },
  PLACEHOLDER_CONTENT_RE: '^Thinking( [0-9]|…)',
 });
 const out = await jobs.cancelFarmAgentJob({ workspaceId: 'ws-farm', jobId: 'job-farm-1' });
 await new Promise((resolve) => setImmediate(resolve));
 assert.equal(out.status, 'cancelled');
 assert.equal(expiredRows.length, 1);
 assert.equal(sent.some((m) => m.type === 'agent_permission_abort' && m.requestId === 'perm-farm-1'), true);
 assert.equal(sent.some((m) => m.type === 'agent_job_cancel' && m.jobId === 'job-farm-1'), true);
 assert.equal(parentNotices.length, 1);
 assert.match(parentNotices[0].content, /\[child-failure:job-farm-1\]/);
});


