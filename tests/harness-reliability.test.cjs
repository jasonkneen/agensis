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
