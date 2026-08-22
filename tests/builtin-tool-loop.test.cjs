// ============================================================================
// tests/builtin-tool-loop.test.cjs
// ----------------------------------------------------------------------------
// A BUILT-IN agent used to be sent a bare completion — model, messages, system,
// and no `tools` — so it could only ever emit text. It would announce that it
// was "calling the create_thread_item MCP tool" and then call nothing, because
// there was nothing to call. The tools were real the whole time; they were just
// behind a door (MCP) that server-run turns never went through.
//
// What is pinned here:
//   1. ONE tool list, TWO doors. The builtin toolset is a PROJECTION of the same
//      buildTools() the MCP endpoint serves — same names, same schemas, same
//      `kinds` filter. A second hand-written copy is how an agent ends up
//      calling a tool that was renamed a month ago, so the exclusion list is
//      checked against the real tools too: a stale exclusion is a test failure.
//   2. The loop terminates, on every path: no tool use, one call, a chain, the
//      step cap, and the per-turn tool-call budget.
//   3. A tool that THROWS becomes a tool_result the model can read and recover
//      from — never a dead turn.
//   4. Tool calls run with the AGENT's authority in ITS workspace. The identity
//      is built from the agent ROW, so another workspace is unreachable rather
//      than merely refused.
//   5. The work is SURFACED: real `tool_step` rows — the same discriminator and
//      the same tool_name/tool_detail columns a daemon turn writes — so builtin
//      steps render through the chip UI that already exists.
//   6. The daemon lane is untouched: nothing in this feature is reachable
//      outside the `runMode === 'builtin'` branch.
//
// The model and the tools are mocked throughout. No live API calls.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');
const { createBuiltinTurn } = require('../server/builtin-turn.cjs');
const {
  createBuiltinToolset,
  BUILTIN_TOOL_EXCLUSIONS,
  __test: MCP_TEST,
} = require('../server/mcp.cjs');

const root = path.resolve(__dirname, '..');
// runAgentTurn and the tool loop moved to server/builtin-turn.cjs (Wave 4 of
// the index.cjs reduction). The lane assertions below read the whole Fly lane;
// the ones that slice runAgentTurn's four branches read that MODULE, because a
// slice bounded by "the next thing after runAgentTurn" is only meaningful
// inside the file runAgentTurn lives in — continueConversation stayed in
// index.cjs, and index.cjs is concatenated FIRST, so bounding on it returned -1.
const SERVER = require('./helpers/fly-lane.cjs').flyLaneSource();
const TURN = fs.readFileSync(path.join(root, 'server/builtin-turn.cjs'), 'utf8');
// runAgentTurn's four lanes end where the next top-level declaration in the
// module begins.
const RUN_AGENT_TURN_END = TURN.indexOf('\n async function runAnthropicCompletion(');

const WORKSPACE_ID = 'ws-1';
const OTHER_WORKSPACE_ID = 'ws-2';
const SESSION_ID = 'session-1';

const AGENT_ROW = {
  id: 'agent-1',
  workspace_id: WORKSPACE_ID,
  name: 'Coder',
  handle: 'coder',
  model: 'auto',
  run_mode: 'builtin',
  enabled: true,
  system_prompt: 'be useful',
  tools: '[]',
  skills: '[]',
};

// ---------------------------------------------------------------------------
// (0) Voice huddles disable Claude's hidden reasoning only on the spoken lane.
// The request body is captured through the module seam rather than global fetch.
// ---------------------------------------------------------------------------

test('live huddle builtin requests disable Anthropic thinking, ordinary turns do not', async () => {
  const requests = [];
  const turn = createBuiltinTurn({
    getAnthropicApiKey: async () => 'test-key',
    resolveAnthropicModel: (model) => model || 'claude-test',
    buildSystemPrompt: () => 'system',
    createAnthropicUsageAccumulator: () => ({ event: () => {}, result: () => ({}) }),
    recordAnthropicUsage: async () => {},
    dbQuery: () => {},
    anthropicFetch: async (request) => {
      requests.push(request);
      return new Response('', { status: 200 });
    },
  });

  await turn.streamAnthropicTurn({ model: 'claude-test', messages: [], voiceHuddle: true });
  await turn.streamAnthropicTurn({ model: 'claude-test', messages: [], voiceHuddle: false });

  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.equal(Object.hasOwn(requests[1].body, 'thinking'), false);
});

// ---------------------------------------------------------------------------
// (1) The loop itself. callModel/callTool are injected, which is the whole point
//     of runToolUseLoop being separate from the DB and from Anthropic.
// ---------------------------------------------------------------------------

/** A scripted model: one entry per call, each either plain text or tool_use. */
function scriptedModel(script) {
  const calls = [];
  const model = async ({ messages, tools }) => {
    calls.push({ messages: JSON.parse(JSON.stringify(messages)), tools });
    const next = script[Math.min(calls.length - 1, script.length - 1)];
    return { text: next.text || '', toolUses: next.toolUses || [], stopReason: next.toolUses ? 'tool_use' : 'end_turn' };
  };
  model.calls = calls;
  return model;
}

function use(id, name, input = {}, extra = {}) {
  return { id, name, input, inputError: '', ...extra };
}

test('a turn with no tool use behaves exactly as before: one model call, its text', async () => {
  const callModel = scriptedModel([{ text: 'Here is the answer.' }]);
  const toolCalls = [];
  const segments = [];

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'hello' }],
    tools: [{ name: 'whoami', description: '', input_schema: {} }],
    callModel,
    callTool: async (call) => { toolCalls.push(call); return { ok: true, value: {} }; },
    onSegment: (text) => { segments.push(text); },
  });

  assert.equal(result.text, 'Here is the answer.');
  assert.equal(result.steps, 1);
  assert.equal(result.toolCalls, 0);
  assert.equal(result.hitCap, false);
  assert.equal(callModel.calls.length, 1, 'exactly one model call');
  assert.deepEqual(toolCalls, [], 'no tool was executed');
  assert.deepEqual(segments, [], 'no text block was sealed — the reply is the only block');
  // The conversation handed to the model is untouched by the loop.
  assert.deepEqual(callModel.calls[0].messages, [{ role: 'user', content: 'hello' }]);
});

test('builtin cancellation stops the loop before another model or tool boundary', async () => {
  const beforeStart = new AbortController();
  const cleared = Object.assign(new Error('Conversation cleared'), { code: 'builtin_job_cancelled' });
  beforeStart.abort(cleared);
  let modelCalls = 0;
  let toolCalls = 0;

  await assert.rejects(
    () => __test.runToolUseLoop({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'read_channel', description: '', input_schema: {} }],
      signal: beforeStart.signal,
      callModel: async () => { modelCalls += 1; return { text: 'should not run', toolUses: [] }; },
      callTool: async () => { toolCalls += 1; return { ok: true, value: {} }; },
    }),
    (error) => error === cleared,
  );
  assert.equal(modelCalls, 0);
  assert.equal(toolCalls, 0);

  const duringModel = new AbortController();
  await assert.rejects(
    () => __test.runToolUseLoop({
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'read_channel', description: '', input_schema: {} }],
      signal: duringModel.signal,
      callModel: async () => {
        modelCalls += 1;
        duringModel.abort(cleared);
        return { text: '', toolUses: [use('tu-cancelled', 'read_channel')] };
      },
      callTool: async () => { toolCalls += 1; return { ok: true, value: {} }; },
    }),
    (error) => error === cleared,
  );
  assert.equal(modelCalls, 1, 'the in-flight model call settled once');
  assert.equal(toolCalls, 0, 'its requested tool never started after cancellation');
});

test('builtin cancellation is keyed and cleaned up by the exact agent job id', () => {
  assert.match(TURN, /const builtinAbortControllers = new Map\(\)/);
  assert.match(TURN, /builtinAbortControllers\.set\(builtinJobId, abortController\)/);
  assert.match(
    TURN,
    /function cancelBuiltinJob\(jobId,[\s\S]*?builtinAbortControllers\.get\(id\)[\s\S]*?controller\.abort\(builtinCancellationError\(reason\)\)/,
  );
  assert.match(
    TURN,
    /builtinAbortControllers\.get\(builtinJobId\) === abortController[\s\S]*?builtinAbortControllers\.delete\(builtinJobId\)/,
    'an older turn cannot delete a replacement controller for the same id',
  );
  const terminalRunningCas = TURN.match(/where id = \$1 and status = 'running' returning \*/g) || [];
  assert.ok(terminalRunningCas.length >= 2, 'both done and error terminal writes preserve a winning cancellation');
});

test('a single tool call executes, and its result reaches the model', async () => {
  const callModel = scriptedModel([
    { text: 'Let me look.', toolUses: [use('tu-1', 'read_channel', { channel_id: 'ch-1' })] },
    { text: 'It says hello.' },
  ]);
  const executed = [];

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'what is in #general?' }],
    tools: [{ name: 'read_channel', description: '', input_schema: {} }],
    callModel,
    callTool: async (call) => {
      executed.push(call);
      return { ok: true, value: { messages: [{ content: 'hello' }] } };
    },
  });

  assert.equal(result.text, 'It says hello.');
  assert.equal(result.toolCalls, 1);
  assert.equal(callModel.calls.length, 2);
  assert.deepEqual(executed, [{ name: 'read_channel', args: { channel_id: 'ch-1' }, id: 'tu-1' }]);

  // The second call carries the assistant's tool_use turn AND the tool_result.
  const second = callModel.calls[1].messages;
  assert.equal(second.length, 3, 'original message + assistant tool_use + tool_result');
  assert.deepEqual(second[1], {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'tool_use', id: 'tu-1', name: 'read_channel', input: { channel_id: 'ch-1' } },
    ],
  });
  assert.equal(second[2].role, 'user');
  assert.equal(second[2].content[0].type, 'tool_result');
  assert.equal(second[2].content[0].tool_use_id, 'tu-1');
  assert.equal(second[2].content[0].is_error, false);
  assert.match(second[2].content[0].content, /hello/, 'the tool value is what the model reads');
});

test('a multi-step chain terminates when the model stops asking for tools', async () => {
  const callModel = scriptedModel([
    { toolUses: [use('a', 'list_channels')] },
    { text: 'Reading it.', toolUses: [use('b', 'read_channel', { channel_id: 'ch-1' })] },
    { toolUses: [use('c', 'post_message', { channel_id: 'ch-1', content: 'done' })] },
    { text: 'Posted.' },
  ]);
  const segments = [];

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'list_channels', description: '', input_schema: {} }],
    callModel,
    callTool: async () => ({ ok: true, value: 'ok' }),
    onSegment: (text) => { segments.push(text); },
  });

  assert.equal(result.text, 'Posted.');
  assert.equal(result.steps, 4);
  assert.equal(result.toolCalls, 3);
  assert.equal(result.hitCap, false);
  // Only the round that produced text sealed a block; the two silent rounds did
  // not leave an empty message behind.
  assert.deepEqual(segments, ['Reading it.']);
});

test('the iteration cap holds, and the capped turn still ends with an answer', async () => {
  // A model that never stops asking for tools.
  const callModel = scriptedModel([{ text: '', toolUses: [use('x', 'list_channels')] }]);
  // The closing call is the only one made with no tools, so the script's last
  // entry cannot be what answers it — override by tool presence instead.
  const wrapped = async ({ messages, tools }) => {
    const turn = await callModel({ messages, tools });
    if (!tools || tools.length === 0) return { text: 'Out of tool budget, here is what I have.', toolUses: [] };
    return turn;
  };

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'loop forever' }],
    tools: [{ name: 'list_channels', description: '', input_schema: {} }],
    callModel: wrapped,
    callTool: async () => ({ ok: true, value: 'ok' }),
    maxSteps: 3,
  });

  assert.equal(result.hitCap, true);
  assert.equal(result.text, 'Out of tool budget, here is what I have.');
  assert.equal(result.toolCalls, 3, 'one tool per capped step, and no more');
  // 3 capped calls WITH tools, then exactly one closing call WITHOUT them.
  assert.equal(callModel.calls.length, 4);
  assert.deepEqual(callModel.calls.slice(0, 3).map((c) => c.tools.length > 0), [true, true, true]);
  assert.equal(callModel.calls[3].tools.length, 0, 'the closing call has no tool to reach for');
});

test('the default cap is stated, not implicit', () => {
  assert.equal(__test.BUILTIN_TOOL_LOOP_MAX_STEPS, 8);
  assert.equal(__test.BUILTIN_TOOL_LOOP_MAX_CALLS, 24);
  // The model is told the number rather than being left to discover it.
  assert.match(__test.BUILTIN_TOOL_NOTE, new RegExp(`at most ${__test.BUILTIN_TOOL_LOOP_MAX_STEPS} rounds`));
});

test('the per-turn tool budget bounds a single response full of tool calls', async () => {
  const many = Array.from({ length: 5 }, (_, i) => use(`t${i}`, 'list_channels'));
  const callModel = scriptedModel([
    { toolUses: many },
    { text: 'Enough.' },
  ]);
  let executed = 0;

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'list_channels', description: '', input_schema: {} }],
    callModel,
    callTool: async () => { executed += 1; return { ok: true, value: 'ok' }; },
    maxToolCalls: 2,
  });

  assert.equal(executed, 2, 'the budget stops execution, it does not merely warn');
  assert.equal(result.toolCalls, 2);
  // The three refused calls still get a readable result each — a tool_use with no
  // matching tool_result is a malformed request the next model call would reject.
  const results = callModel.calls[1].messages[2].content;
  assert.equal(results.length, 5);
  assert.deepEqual(results.map((r) => r.is_error), [false, false, true, true, true]);
  assert.match(results[4].content, /budget/i);
});

test('a throwing tool becomes a readable error the model can recover from', async () => {
  const callModel = scriptedModel([
    { toolUses: [use('t-1', 'write_doc', { title: 'x' })] },
    { text: 'I could not write that doc: the title was rejected.' },
  ]);

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'write a doc' }],
    tools: [{ name: 'write_doc', description: '', input_schema: {} }],
    callModel,
    // This is the shape runToolForIdentity guarantees for a tool that threw.
    callTool: async () => ({ ok: false, error: 'Missing required string argument: title' }),
  });

  assert.equal(result.text, 'I could not write that doc: the title was rejected.', 'the turn is not dead');
  assert.equal(result.steps, 2);
  const toolResult = callModel.calls[1].messages[2].content[0];
  assert.equal(toolResult.is_error, true);
  assert.equal(toolResult.content, 'Missing required string argument: title');
});

test('unparseable tool arguments are reported, never executed with a guess', async () => {
  const callModel = scriptedModel([
    { toolUses: [{ id: 'bad', name: 'create_task', input: {}, inputError: 'Tool arguments were not valid JSON.' }] },
    { text: 'Sorry, I garbled that.' },
  ]);
  let executed = 0;

  const result = await __test.runToolUseLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ name: 'create_task', description: '', input_schema: {} }],
    callModel,
    callTool: async () => { executed += 1; return { ok: true, value: 'ok' }; },
  });

  assert.equal(executed, 0, 'nothing ran');
  assert.equal(result.toolCalls, 0, 'a call that never happened does not spend the budget');
  assert.equal(callModel.calls[1].messages[2].content[0].is_error, true);
  assert.equal(result.text, 'Sorry, I garbled that.');
});

test('a tool result is bounded — a huge one is truncated with a visible marker', () => {
  const huge = 'x'.repeat(__test.BUILTIN_TOOL_RESULT_MAX_CHARS + 5_000);
  const text = __test.toolResultText(huge);
  assert.ok(text.length < huge.length);
  assert.match(text, /\[truncated: result was \d+ characters\]/);
  // A normal result is passed through untouched.
  assert.equal(__test.toolResultText('short'), 'short');
  assert.equal(__test.toolResultText({ a: 1 }), JSON.stringify({ a: 1 }, null, 2));
});

// ---------------------------------------------------------------------------
// (2) ONE list, TWO doors: the builtin tool schemas are a projection of the MCP
//     ones, never a second copy.
// ---------------------------------------------------------------------------

function agentIdentity(workspaceId = WORKSPACE_ID) {
  return {
    kind: 'agent',
    agentId: AGENT_ROW.id,
    workspaceId,
    name: AGENT_ROW.name,
    handle: AGENT_ROW.handle,
    agent: { model: 'claude-opus-4-8' },
  };
}

test('builtin tool schemas come from buildTools(), not from a second list', () => {
  const identity = agentIdentity();
  const toolset = createBuiltinToolset({});
  const specs = toolset.specs(identity);
  const source = new Map(MCP_TEST.buildTools().map((t) => [t.name, t]));

  assert.ok(specs.length > 5, 'a builtin agent gets a real toolset, not a token one');
  for (const spec of specs) {
    const tool = source.get(spec.name);
    assert.ok(tool, `${spec.name} must exist in buildTools()`);
    assert.equal(spec.description, tool.description);
    // Anthropic spells it input_schema; it is the SAME schema object tools/list
    // serves, so the two doors cannot describe a tool differently.
    assert.deepEqual(spec.input_schema, tool.inputSchema);
  }
});

test('the builtin toolset is exactly the agent-reachable MCP tools minus the stated exclusions', () => {
  const identity = agentIdentity();
  const specNames = createBuiltinToolset({}).specs(identity).map((s) => s.name).sort();
  const mcpNames = MCP_TEST.buildTools()
    .filter((tool) => MCP_TEST.toolAllowedForIdentity(tool, identity))
    .map((t) => t.name);
  const expected = mcpNames.filter((name) => !BUILTIN_TOOL_EXCLUSIONS.includes(name)).sort();

  assert.deepEqual(specNames, expected);
  // The tools an agent really needs are actually in there.
  for (const name of ['create_thread_item', 'call_provider', 'post_message', 'create_task', 'read_channel']) {
    assert.ok(specNames.includes(name), `${name} must be reachable from a builtin turn`);
  }
});

test('every exclusion names a tool that still exists — a stale one is a failure', () => {
  const names = new Set(MCP_TEST.buildTools().map((t) => t.name));
  for (const name of BUILTIN_TOOL_EXCLUSIONS) {
    assert.ok(names.has(name), `BUILTIN_TOOL_EXCLUSIONS names "${name}", which no longer exists`);
  }
  // The job-queue plumbing and the token minter, and nothing else.
  assert.deepEqual([...BUILTIN_TOOL_EXCLUSIONS].sort(),
    ['claim_job', 'fail_job', 'get_connect_command', 'submit_job_result']);
});

test('an excluded tool is refused even if it is named directly', async () => {
  const toolset = createBuiltinToolset({});
  for (const name of BUILTIN_TOOL_EXCLUSIONS) {
    const outcome = await toolset.call({ name, args: {}, identity: agentIdentity(), db: null });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /not available to a Direct agent turn/);
  }
});

// ---------------------------------------------------------------------------
// (3) RBAC: an agent's tools run with the agent's authority, in ITS workspace.
// ---------------------------------------------------------------------------

/** A DB that only knows ch-1 (in ws-1) and ch-x (in ws-2). */
function tenancyDb() {
  return {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('select id from chat_sessions where id = $1 and workspace_id = $2')) {
        const [id, ws] = params;
        if (id === 'ch-1' && ws === WORKSPACE_ID) return [{ id: 'ch-1' }];
        if (id === 'ch-x' && ws === OTHER_WORKSPACE_ID) return [{ id: 'ch-x' }];
        return [];
      }
      if (n.startsWith('select id, title, folder')) return [];
      return [];
    },
  };
}

test('the tool identity takes its workspace from the agent ROW, not from the request', () => {
  const identity = __test.builtinToolIdentity(AGENT_ROW, WORKSPACE_ID);
  assert.equal(identity.kind, 'agent');
  assert.equal(identity.agentId, AGENT_ROW.id);
  assert.equal(identity.workspaceId, WORKSPACE_ID);
  assert.equal(identity.handle, 'coder');
  // Same shape verifyAgentConnectToken hands the MCP door, so the tools cannot
  // tell the two apart.
  assert.ok(identity.agent && typeof identity.agent === 'object');
});

test('the tool identity fails closed rather than guessing a workspace', () => {
  // A select that forgot workspace_id: no identity, so the turn runs with no
  // tools instead of with tools scoped to a workspace nobody can name.
  const { workspace_id: _dropped, ...noWorkspace } = AGENT_ROW;
  assert.equal(__test.builtinToolIdentity(noWorkspace, WORKSPACE_ID), null);
  // And a row that disagrees with the turn it is running in is refused outright.
  assert.equal(__test.builtinToolIdentity(AGENT_ROW, OTHER_WORKSPACE_ID), null);
});

test('a builtin turn cannot reach another workspace', async () => {
  const toolset = createBuiltinToolset({ notifyDbSubscribers() { } });
  const db = tenancyDb();

  // Its own channel is fine.
  const own = await toolset.call({
    name: 'read_channel', args: { channel_id: 'ch-1' }, identity: agentIdentity(), db,
  });
  assert.equal(own.ok, true);

  // Another workspace's channel is not — and the refusal does not confirm that
  // the channel exists somewhere else either.
  const foreign = await toolset.call({
    name: 'read_channel', args: { channel_id: 'ch-x' }, identity: agentIdentity(), db,
  });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /not found in this workspace/i);

  // And posting into it is refused by the same scoping.
  const post = await toolset.call({
    name: 'post_message', args: { channel_id: 'ch-x', content: 'hi' }, identity: agentIdentity(), db,
  });
  assert.equal(post.ok, false);
  assert.match(post.error, /not found in this workspace/i);
});

test('a tool outside the agent kind is refused, not silently allowed', async () => {
  const toolset = createBuiltinToolset({});
  // register_agent is kinds: ['workspace','user','invite'] — an agent already IS one.
  const outcome = await toolset.call({
    name: 'register_agent', args: { name: 'Impostor' }, identity: agentIdentity(), db: null,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /not available for a agent token/);
});

test('an unknown tool is a readable refusal, not a crash', async () => {
  const outcome = await createBuiltinToolset({}).call({
    name: 'rm_rf', args: {}, identity: agentIdentity(), db: null,
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Unknown tool: rm_rf/);
});

test('a tool that throws is caught at the shared execution path, for both doors', async () => {
  const boom = { name: 'boom', kinds: ['agent'], description: '', inputSchema: {}, async run() { throw new Error('kaboom'); } };
  const outcome = await MCP_TEST.runToolForIdentity({
    name: 'boom', args: {}, identity: agentIdentity(), db: null, deps: {},
    toolMap: new Map([['boom', boom]]),
  });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /Internal error executing boom: kaboom/);
});

// ---------------------------------------------------------------------------
// (4) The turn, end to end: tools attached, steps surfaced, blocks sealed.
// ---------------------------------------------------------------------------

/** One Anthropic SSE body from a list of {text} / {toolUse} blocks. */
function sseBody(blocks) {
  const frames = [];
  let index = 0;
  for (const block of blocks) {
    if (block.text !== undefined) {
      frames.push({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      frames.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } });
      frames.push({ type: 'content_block_stop', index });
    } else {
      frames.push({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: block.id, name: block.name } });
      // Split the argument JSON across two frames: the partial_json only parses
      // once reassembled, which is the whole reason the block is buffered.
      const json = JSON.stringify(block.input || {});
      frames.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, 3) } });
      frames.push({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(3) } });
      frames.push({ type: 'content_block_stop', index });
    }
    index += 1;
  }
  frames.push({ type: 'message_delta', delta: { stop_reason: blocks.some((b) => b.name) ? 'tool_use' : 'end_turn' } });
  return frames.map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join('');
}

/** Replace global fetch with a script of SSE responses; returns the request log. */
function installFetch(responses) {
  const requests = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const scripted = responses[Math.min(requests.length - 1, responses.length - 1)];
    const body = typeof scripted === 'function' ? scripted({ url, init }) : scripted;
    return {
      ok: true,
      body: (async function* stream() { yield Buffer.from(body); })(),
      async text() { return body; },
    };
  };
  requests.restore = () => { globalThis.fetch = original; };
  return requests;
}

function installTurnDb({ reservationAccepted = true, agentMcpApproved = true } = {}) {
  const store = new Map();
  const jobs = new Map();
  const receiptWrites = [];
  const receiptAttempts = [];
  let seq = 0;
  store.set('msg-human', {
    id: 'msg-human', session_id: SESSION_ID, role: 'user', content: '@coder check #general',
    thread_parent_id: null, sender_kind: 'user', sender_id: 'user-1', sender_name: 'Jason',
    broadcast_to_channel: false, created_at: '2026-07-25T10:00:00.000Z',
  });

  const db = {
    store,
    jobs,
    receiptWrites,
    receiptAttempts,
    async begin(callback) { return callback(db); },
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      const lower = n.toLowerCase();

      if (lower.startsWith('with readable_agent_session as materialized')) {
        // Emulate the load-bearing SQL predicates instead of returning a marker
        // unconditionally. This makes the end-to-end builtin test below fail if
        // read-marker authorization is accidentally tied back to MCP approval.
        receiptAttempts.push(params.map(String));
        if (lower.includes('marker_agent.mcp_approved is true') && !agentMcpApproved) return [];
        if (params[0] !== SESSION_ID || params[1] !== AGENT_ROW.id) return [];
        const seen = store.get(String(params[2]));
        if (!seen || seen.session_id !== SESSION_ID) return [];
        if (seen.sender_kind === 'agent' && String(seen.sender_id || '') === AGENT_ROW.id) return [];
        const readScopeThreadParentId = params[3] == null ? null : String(params[3]);
        if (readScopeThreadParentId === null && seen.thread_parent_id && !seen.broadcast_to_channel) return [];
        if (readScopeThreadParentId !== null
          && seen.id !== readScopeThreadParentId
          && seen.thread_parent_id !== readScopeThreadParentId) return [];
        const marker = {
          marker_id: `marker-${AGENT_ROW.id}-${readScopeThreadParentId || 'channel'}`,
          event_version: String(receiptWrites.length + 1),
          session_id: SESSION_ID,
          user_id: null,
          agent_id: AGENT_ROW.id,
          thread_parent_id: readScopeThreadParentId,
          last_seen_message_id: seen.id,
          read_at: seen.created_at,
        };
        receiptWrites.push(marker);
        return [{ ...marker }];
      }

      if (lower.startsWith('select s.id from chat_sessions s join workspace_agents a')) {
        return reservationAccepted ? [{ id: params[2] }] : [];
      }

      if (n.startsWith('select id, role, content, sender_kind, sender_id, sender_name, message_kind')) {
        const threadScoped = lower.includes('(id = $2 or thread_parent_id = $2)');
        return [...store.values()]
          .filter((row) => row.session_id === params[0])
          .filter((row) => threadScoped
            ? row.id === params[1] || row.thread_parent_id === params[1]
            : !row.thread_parent_id || row.broadcast_to_channel)
          .sort((a, b) => (
            String(b.created_at).localeCompare(String(a.created_at))
            || String(b.id).localeCompare(String(a.id))
          ));
      }
      if (n.startsWith("select id from messages where session_id = $1 and thread_parent_id is null and role = 'user'")) {
        const rows = [...store.values()].filter((r) => r.session_id === params[0] && !r.thread_parent_id && r.role === 'user');
        return rows.length > 0 ? [{ id: rows[0].id }] : [];
      }
      if (n.startsWith('insert into agent_jobs')) {
        const job = { id: `job-${++seq}`, workspace_id: params[0], agent_id: params[1], session_id: SESSION_ID, status: 'running', metadata: params[params.length - 1] };
        jobs.set(job.id, job);
        return [{ ...job }];
      }
      if (n.startsWith('update agent_jobs')) {
        const job = jobs.get(params[0]);
        if (!job) return [];
        if (n.includes("status = 'done'")) { job.status = 'done'; job.response = params[1]; }
        if (n.includes("status = 'error'")) { job.status = 'error'; job.error = params[1]; }
        return [{ ...job }];
      }
      // Tool-step insert (10 columns) — recognised before the shorter shapes.
      if (n.startsWith('insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name, message_kind')) {
        const row = {
          id: `msg-${++seq}`, session_id: params[0], role: 'assistant', content: params[1],
          thread_parent_id: params[2] ?? null, sender_kind: 'agent', sender_id: params[3], sender_name: params[4],
          message_kind: 'tool_step', tool_name: params[5], tool_detail: params[6],
          broadcast_to_channel: false, created_at: new Date().toISOString(),
        };
        store.set(row.id, row);
        return [{ ...row }];
      }
      if (n.startsWith('insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name')) {
        const placeholder = n.includes("'assistant', 'Thinking 0s'");
        const row = {
          id: params[0], session_id: params[1], role: 'assistant',
          content: placeholder ? 'Thinking 0s' : params[2],
          thread_parent_id: placeholder ? (params[2] ?? null) : (params[3] ?? null),
          sender_kind: 'agent',
          sender_id: placeholder ? params[3] : params[4],
          sender_name: placeholder ? params[4] : params[5],
          message_kind: '', tool_name: '', tool_detail: '',
          broadcast_to_channel: n.includes('broadcast_to_channel') ? Boolean(params[6]) : false,
          created_at: new Date().toISOString(),
        };
        store.set(row.id, row);
        return [{ ...row }];
      }
      if (n.startsWith('update messages set content = $2, broadcast_to_channel = $4')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[2]) return [];
        row.content = params[1];
        row.broadcast_to_channel = Boolean(params[3]);
        return [{ ...row }];
      }
      if (n.startsWith('update messages set content = $2, tool_detail = $3')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[3]) return [];
        row.content = params[1];
        row.tool_detail = params[2];
        return [{ ...row }];
      }
      if (n.startsWith('update messages set content = $2 where id = $1 and session_id = $3')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[2]) return [];
        row.content = params[1];
        return [{ ...row }];
      }
      // The tools' own reads: ch-1 belongs to this workspace, nothing else does.
      if (lower.startsWith('select id from chat_sessions where id = $1 and workspace_id = $2')) {
        return (params[0] === 'ch-1' && params[1] === WORKSPACE_ID) ? [{ id: 'ch-1' }] : [];
      }
      return [];
    },
  };
  __test.setTestDb(db);
  return db;
}

const steps = (db) => [...db.store.values()].filter((r) => r.message_kind === 'tool_step');
const bubbles = (db) => [...db.store.values()].filter((r) => r.sender_kind === 'agent' && r.message_kind !== 'tool_step');

test.afterEach(() => __test.resetTestState());

test('an external turn posts no queued stand-in when its final live-scope reservation fails', async () => {
  const db = installTurnDb({ reservationAccepted: false });
  const result = await __test.runAgentTurn(
    { ...AGENT_ROW, run_mode: 'external' },
    { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, createdBy: 'user-1' },
  );

  assert.deepEqual(result, { ok: false, pending: true });
  assert.equal(db.jobs.size, 0, 'no job was queued');
  assert.deepEqual(
    [...db.store.values()].map((row) => row.id),
    ['msg-human'],
    'no removed-agent or falsely queued stand-in was written',
  );
});

test('a builtin turn attaches tools, runs one, surfaces it as a chip, and answers', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const db = installTurnDb();
  const requests = installFetch([
    sseBody([{ text: 'Looking now.' }, { id: 'tu-1', name: 'read_channel', input: { channel_id: 'ch-1' } }]),
    sseBody([{ text: 'Nothing new in there.' }]),
  ]);

  try {
    const result = await __test.runAgentTurn(AGENT_ROW, {
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, createdBy: 'user-1',
    });
    assert.deepEqual(result, { ok: true, pending: false });

    // (a) The request actually carried tools — the bug this whole feature fixes.
    assert.equal(requests.length, 2, 'one call to decide, one to answer');
    assert.ok(Array.isArray(requests[0].body.tools) && requests[0].body.tools.length > 0,
      'the FIRST request must carry a tools array');
    assert.ok(requests[0].body.tools.some((t) => t.name === 'read_channel'));
    assert.ok(requests[0].body.tools.every((t) => t.input_schema && typeof t.input_schema === 'object'));
    assert.match(requests[0].body.system, /MAKE THE TOOL CALL/, 'the agent is told to call, not narrate');

    // (b) The tool result reached the model as a tool_result block.
    const second = requests[1].body.messages;
    const resultBlock = second[second.length - 1].content[0];
    assert.equal(resultBlock.type, 'tool_result');
    assert.equal(resultBlock.tool_use_id, 'tu-1');
    assert.equal(resultBlock.is_error, false);

    // (c) The step is surfaced as a real tool_step row: same discriminator and
    //     same columns the chip renderer already reads for daemon agents.
    const chips = steps(db);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].tool_name, 'read_channel');
    assert.match(chips[0].tool_detail, /ch-1/);
    assert.equal(chips[0].content, `read_channel · ${chips[0].tool_detail}`);
    // Siblings of the reply inside the work thread, exactly where the daemon
    // path puts them — not buried a level deeper under the placeholder.
    assert.equal(chips[0].thread_parent_id, 'msg-human');

    // (d) The text before the tool call is its OWN message, and the final answer
    //     is a separate one flagged for the channel.
    const texts = bubbles(db).map((r) => ({ content: r.content, broadcast: r.broadcast_to_channel }));
    assert.deepEqual(texts, [
      { content: 'Looking now.', broadcast: false },
      { content: 'Nothing new in there.', broadcast: true },
    ]);

    // (e) The job finished clean.
    const job = [...db.jobs.values()][0];
    assert.equal(job.status, 'done');
    assert.equal(job.response, 'Nothing new in there.');
  } finally {
    requests.restore();
  }
});

test('a builtin turn with no tool use still writes exactly one reply, as before', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const db = installTurnDb();
  const requests = installFetch([sseBody([{ text: 'Just an answer.' }])]);

  try {
    const result = await __test.runAgentTurn(AGENT_ROW, {
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, createdBy: 'user-1',
    });
    assert.deepEqual(result, { ok: true, pending: false });
    assert.equal(requests.length, 1, 'exactly one model call — no extra round trip');
    assert.deepEqual(steps(db), [], 'no chips for a turn that used no tools');
    const texts = bubbles(db);
    assert.equal(texts.length, 1, 'one reply, in the placeholder it streamed into');
    assert.equal(texts[0].content, 'Just an answer.');
    assert.equal(texts[0].broadcast_to_channel, true);
  } finally {
    requests.restore();
  }
});

test('a default builtin agent records a receipt without MCP approval', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const db = installTurnDb({ agentMcpApproved: false });
  const requests = installFetch([sseBody([{ text: 'Read and understood.' }])]);

  try {
    const result = await __test.runAgentTurn(
      { ...AGENT_ROW, mcp_approved: false },
      { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, createdBy: 'user-1' },
    );
    assert.deepEqual(result, { ok: true, pending: false });
    assert.deepEqual(db.receiptWrites, [{
      marker_id: `marker-${AGENT_ROW.id}-channel`,
      event_version: '1',
      session_id: SESSION_ID,
      user_id: null,
      agent_id: AGENT_ROW.id,
      thread_parent_id: null,
      last_seen_message_id: 'msg-human',
      read_at: '2026-07-25T10:00:00.000Z',
    }]);
    assert.deepEqual(db.receiptAttempts, [[SESSION_ID, AGENT_ROW.id, 'msg-human', 'null']]);
  } finally {
    requests.restore();
  }
});

test('a builtin receipt stays pinned to its thread snapshot while newer messages arrive', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const db = installTurnDb({ agentMcpApproved: false });
  db.store.set('thread-reply', {
    id: 'thread-reply',
    session_id: SESSION_ID,
    role: 'user',
    content: 'the scoped question',
    thread_parent_id: 'msg-human',
    sender_kind: 'user',
    sender_id: 'user-1',
    sender_name: 'Jason',
    broadcast_to_channel: false,
    created_at: '2026-07-25T10:01:00.000Z',
  });
  const requests = installFetch([() => {
    // The context query has completed when the provider call begins. This later,
    // top-level message must not widen a marker captured for the thread.
    db.store.set('msg-late', {
      id: 'msg-late',
      session_id: SESSION_ID,
      role: 'user',
      content: 'arrived after prompt capture',
      thread_parent_id: null,
      sender_kind: 'user',
      sender_id: 'user-2',
      sender_name: 'Later',
      broadcast_to_channel: false,
      created_at: '2026-07-25T10:02:00.000Z',
    });
    return sseBody([{ text: 'Scoped answer.' }]);
  }]);

  try {
    const result = await __test.runAgentTurn(
      { ...AGENT_ROW, mcp_approved: false },
      {
        workspaceId: WORKSPACE_ID,
        sessionId: SESSION_ID,
        threadParentId: 'msg-human',
        createdBy: 'user-1',
      },
    );
    assert.deepEqual(result, { ok: true, pending: false });
    assert.deepEqual(
      db.receiptAttempts,
      [[SESSION_ID, AGENT_ROW.id, 'thread-reply', 'msg-human']],
      'the exact newest inbound row in the delivered thread is the only candidate',
    );
    assert.equal(db.receiptWrites[0]?.thread_parent_id, 'msg-human');
    assert.equal(db.receiptWrites[0]?.last_seen_message_id, 'thread-reply');
    assert.equal(db.receiptWrites[0]?.read_at, '2026-07-25T10:01:00.000Z');
  } finally {
    requests.restore();
  }
});

test('a builtin receipt uses message id to order equal-time context rows', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const db = installTurnDb();
  db.store.set('msg-zzzz', {
    id: 'msg-zzzz',
    session_id: SESSION_ID,
    role: 'user',
    content: 'same timestamp, deterministic later tuple',
    thread_parent_id: null,
    sender_kind: 'user',
    sender_id: 'user-2',
    sender_name: 'Later tuple',
    broadcast_to_channel: false,
    created_at: '2026-07-25T10:00:00.000Z',
  });
  const requests = installFetch([sseBody([{ text: 'Both equal-time messages were delivered.' }])]);

  try {
    const result = await __test.runAgentTurn(AGENT_ROW, {
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, createdBy: 'user-1',
    });
    assert.deepEqual(result, { ok: true, pending: false });
    assert.deepEqual(
      db.receiptAttempts,
      [[SESSION_ID, AGENT_ROW.id, 'msg-zzzz', 'null']],
      'the id-desc tie-breaker must agree with the marker tuple comparison',
    );
    assert.equal(db.receiptWrites[0]?.last_seen_message_id, 'msg-zzzz');
  } finally {
    requests.restore();
  }
});

test('a failing tool marks its own chip and the turn still produces a reply', async () => {
  process.env.ANTHROPIC_API_KEY = 'test-key';
  const db = installTurnDb();
  const requests = installFetch([
    // ch-x is another workspace's channel: the tool refuses it.
    sseBody([{ id: 'tu-1', name: 'read_channel', input: { channel_id: 'ch-x' } }]),
    sseBody([{ text: 'I could not read that channel.' }]),
  ]);

  try {
    const result = await __test.runAgentTurn(AGENT_ROW, {
      workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, createdBy: 'user-1',
    });
    assert.deepEqual(result, { ok: true, pending: false }, 'a failed tool is not a failed turn');

    const chips = steps(db);
    assert.equal(chips.length, 1);
    assert.equal(chips[0].tool_detail, 'failed');
    assert.equal(chips[0].content, 'read_channel · failed');

    // The model was told WHY, and the error text never leaked into the chip.
    const second = requests[1].body.messages;
    const resultBlock = second[second.length - 1].content[0];
    assert.equal(resultBlock.is_error, true);
    assert.match(resultBlock.content, /not found in this workspace/i);

    const texts = bubbles(db).map((r) => r.content);
    assert.deepEqual(texts, ['I could not read that channel.']);
  } finally {
    requests.restore();
  }
});

// ---------------------------------------------------------------------------
// (5) The other lanes are untouched.
// ---------------------------------------------------------------------------

test('the tool loop is reachable only from the builtin branch', () => {
  // runAgentTurn has four lanes in source order: MCP pull, external, builtin,
  // daemon. Only the third may know about tools.
  const mcpStart = TURN.indexOf('if (hasMcpPresence(agent.id)) {');
  const externalStart = TURN.indexOf("if (runMode === 'external') {", mcpStart);
  const builtinStart = TURN.indexOf("if (runMode === 'builtin') {", externalStart);
  const daemonStart = TURN.indexOf('const connection = findConnectedAgent(', builtinStart);
  const daemonEnd = RUN_AGENT_TURN_END;
  assert.ok(mcpStart > 0 && externalStart > mcpStart && builtinStart > externalStart
    && daemonStart > builtinStart && daemonEnd > daemonStart, 'could not locate the four lanes');

  const symbols = ['getBuiltinToolset', 'runToolUseLoop', 'builtinToolIdentity', 'BUILTIN_TOOL_NOTE', 'toolSpecs'];
  const builtin = TURN.slice(builtinStart, daemonStart);
  for (const symbol of symbols) {
    assert.ok(builtin.includes(symbol), `${symbol} must be used inside the builtin branch`);
  }
  for (const [label, lane] of [
    ['the MCP pull lane', TURN.slice(mcpStart, externalStart)],
    ['the external lane', TURN.slice(externalStart, builtinStart)],
    ['the daemon lane', TURN.slice(daemonStart, daemonEnd)],
  ]) {
    for (const symbol of symbols) {
      assert.ok(!lane.includes(symbol), `${label} must not mention ${symbol}`);
    }
  }
});

test('the daemon lane still sends buildDaemonPrompt, with no tool plumbing added', () => {
  const start = TURN.indexOf('const connection = findConnectedAgent(');
  assert.ok(start > 0, 'could not find the daemon lane');
  const daemonLane = TURN.slice(start, RUN_AGENT_TURN_END);
  assert.match(daemonLane, /buildDaemonPrompt\(contextMessages, agent, coParticipants/);
  assert.ok(!daemonLane.includes('runToolUseLoop'), 'the daemon lane must not run the builtin loop');
  assert.ok(!daemonLane.includes('getBuiltinToolset'), 'the daemon lane must not build a builtin toolset');
});

test('the voice-huddle rule is not weakened by having real tools', () => {
  // Both instructions must survive: never narrate, never claim before success.
  assert.match(__test.VOICE_HUDDLE_NOTE, /Never narrate your tools or plumbing out loud/);
  assert.match(__test.VOICE_HUDDLE_NOTE, /Do not say you have done something until it has actually succeeded/);
  // And the tool note reinforces the same rule rather than competing with it.
  assert.match(__test.BUILTIN_TOOL_NOTE, /Never say you have created, posted, updated or fetched anything until a tool has actually returned success/);
  assert.match(__test.BUILTIN_TOOL_NOTE, /a described call has not run/);
});
