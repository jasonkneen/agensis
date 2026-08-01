'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

test('Amp runtime selection is explicit agent metadata', () => {
  assert.equal(__test.isAmpRuntimeAgent({ metadata: { runtime: 'amp' } }), true);
  assert.equal(__test.isAmpRuntimeAgent({ metadata: { runtime: 'claude' } }), false);
  assert.equal(__test.isAmpRuntimeAgent({ run_mode: 'daemon' }), false);
});

test('generated daemon commands lock explicit agents to their selected runtime', () => {
  const common = {
    baseUrl: 'https://agensis-backend.fly.dev',
    token: 'test-token',
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    handle: 'worker',
    name: 'Worker',
    model: 'claude-opus-4-8',
    permissionMode: 'default',
  };

  const ampCommand = __test.agentConnectionCommand({ ...common, runtime: 'amp', model: 'auto' }).portableCommand;
  assert.match(ampCommand, / --runtime amp(?: |$)/);
  assert.doesNotMatch(ampCommand, / --model /, 'Amp chooses its model inside the Amp thread');
  const codexCommand = __test.agentConnectionCommand({ ...common, runtime: 'codex', model: 'auto' }).portableCommand;
  assert.match(codexCommand, / --runtime codex(?: |$)/);
  assert.doesNotMatch(codexCommand, / --model /);
  assert.match(__test.agentConnectionCommand({ ...common, runtime: 'codex', model: 'gpt-5.4' }).portableCommand, / --model gpt-5\.4(?: |$)/);
  assert.match(__test.agentConnectionCommand({ ...common, runtime: 'claude', model: 'auto' }).portableCommand, / --model claude-opus-4-8(?: |$)/);
  assert.doesNotMatch(__test.agentConnectionCommand(common).portableCommand, / --runtime /);
});

test('agent payloads resolve automatic models for the selected runtime', () => {
  const common = {
    id: 'agent-1',
    workspace_id: 'workspace-1',
    name: 'Worker',
    handle: 'worker',
    model: 'auto',
    run_mode: 'daemon',
    enabled: true,
  };

  assert.equal(
    __test.agentRuntimePayload({ ...common, metadata: { runtime: 'codex' } }).model,
    'auto',
    'Codex must reach the daemon without an Anthropic model override',
  );
  assert.equal(
    __test.agentRuntimePayload({ ...common, metadata: { runtime: 'amp' } }).model,
    'auto',
    'Amp chooses its model inside the Amp thread',
  );
  assert.equal(
    __test.agentRuntimePayload({ ...common, metadata: { runtime: 'claude' } }).model,
    'claude-opus-4-8',
  );
  assert.equal(__test.agentRuntimePayload(common).model, 'claude-opus-4-8');
});

test('agent-token auth carries runtime metadata into the daemon config payload', async () => {
  const row = {
    id: 'agent-1',
    workspace_id: 'workspace-1',
    name: 'Worker',
    handle: 'worker',
    model: 'auto',
    metadata: { runtime: 'codex' },
    run_mode: 'daemon',
    enabled: true,
  };
  const queries = [];
  __test.setTestDb({
    async unsafe(sql) {
      queries.push(String(sql));
      return queries.length === 1 ? [] : [row];
    },
  });

  const auth = await __test.verifyAgentConnectToken(
    'aga_test-token',
    { socket: { remoteAddress: '127.0.0.1' }, url: '/backend/ws?workspaceId=workspace-1&agentId=agent-1' },
  );

  assert.equal(queries.length, 2, 'the loopback fallback exercises both token-auth selects');
  for (const sql of queries) assert.match(sql, /\bmetadata\b/, 'runtime metadata must survive agent-token auth');
  assert.equal(auth.agent.metadata.runtime, 'codex');
  assert.equal(auth.agent.model, 'auto');
});

test('Amp dispatch requires the exact live daemon to advertise runtime support', () => {
  assert.equal(__test.connectionSupportsAmpRuntime({ capabilities: { runtimes: { amp: { id: 'amp', available: false } } } }), true);
  assert.equal(__test.connectionSupportsAmpRuntime({ capabilities: { runtimes: {} } }), false);
  assert.equal(__test.connectionSupportsAmpRuntime({}), false);
});

test('Amp thread binding is loaded from the exact workspace, agent, session, and thread lane', async () => {
  const threadId = 'T-019fa798-10c0-76f8-9844-d848ba21c6d4';
  __test.setTestDb({
    async unsafe(sql, params) {
      assert.match(String(sql), /coalesce\(metadata->>'ampLaneThreadParentId', metadata->>'threadParentId', ''\) = \$4/);
      assert.match(String(sql), /order by finished_at desc nulls last, created_at desc/);
      assert.deepEqual(params, ['workspace-1', 'agent-1', 'session-1', 'parent-1']);
      return [{ metadata: { runtime: 'amp', ampThreadId: threadId } }];
    },
  });

  assert.deepEqual(
    await __test.loadAmpThreadBinding({
      workspaceId: 'workspace-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      threadParentId: 'parent-1',
    }),
    { id: 'amp', continuationRequired: true, threadId, threadUrl: `https://ampcode.com/threads/${threadId}` },
  );
});

test('Amp direct messages reuse one session lane even when each message has a new UI thread parent', async () => {
  const threadId = 'T-019fa798-10c0-76f8-9844-d848ba21c6d4';
  const seenParams = [];
  __test.setTestDb({
    async unsafe(_sql, params) {
      seenParams.push(params);
      return [{ metadata: { runtime: 'amp', ampThreadId: threadId } }];
    },
  });

  const first = await __test.loadAmpThreadBinding({
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    sessionId: 'dm-1',
    threadParentId: 'message-1',
    isDirectMessage: true,
  });
  const second = await __test.loadAmpThreadBinding({
    workspaceId: 'workspace-1',
    agentId: 'agent-1',
    sessionId: 'dm-1',
    threadParentId: 'message-2',
    isDirectMessage: true,
  });

  assert.equal(first.threadId, threadId);
  assert.equal(second.threadId, threadId);
  assert.deepEqual(seenParams.map((params) => params[3]), ['', ''], 'DM bindings key on the session rather than transient message parents');
});

test('a lane with a malformed prior binding requires continuation instead of requesting a new Amp thread', async () => {
  __test.setTestDb({ unsafe: async () => [{ metadata: { runtime: 'amp', ampThreadId: '../../wrong' } }] });
  assert.deepEqual(
    await __test.loadAmpThreadBinding({ workspaceId: 'w', agentId: 'a', sessionId: 's' }),
    { id: 'amp', continuationRequired: true },
  );
});

test('a lane with no prior Amp job requests a new thread', async () => {
  __test.setTestDb({ unsafe: async () => [] });
  assert.deepEqual(
    await __test.loadAmpThreadBinding({ workspaceId: 'w', agentId: 'a', sessionId: 's' }),
    { id: 'amp' },
  );
});

test('daemon Amp result metadata is allowlisted and its URL is derived server-side', () => {
  const threadId = 'T-019fa798-10c0-76f8-9844-d848ba21c6d4';
  assert.deepEqual(__test.ampResultMetadata({
    runtime: 'amp',
    ampThreadId: threadId,
    ampThreadUrl: 'https://evil.example/thread',
    authorization: 'secret',
  }), {
    runtime: 'amp',
    ampThreadId: threadId,
    ampThreadUrl: `https://ampcode.com/threads/${threadId}`,
  });
  assert.deepEqual(__test.ampResultMetadata({ runtime: 'amp', ampThreadId: '../bad', ampErrorCode: 'bad' }), { runtime: 'amp' });
  assert.deepEqual(__test.ampResultMetadata({ runtime: 'other', ampThreadId: threadId }), {});
});

test('Amp result validation is bound to the dispatched job and exact continuation thread', () => {
  const threadId = 'T-019fa798-10c0-76f8-9844-d848ba21c6d4';
  const otherThreadId = 'T-11111111-1111-1111-1111-111111111111';
  assert.deepEqual(
    __test.validateAmpJobResult({ runtime: 'other' }, { runtime: 'amp', ampThreadId: threadId }, ''),
    { metadata: {}, errorText: '' },
  );
  assert.deepEqual(
    __test.validateAmpJobResult({ runtime: 'amp' }, { runtime: 'amp' }, ''),
    {
      metadata: { runtime: 'amp', ampErrorCode: 'amp_stream_invalid' },
      errorText: 'Amp completed without returning the thread linked to this conversation.',
    },
  );
  assert.deepEqual(
    __test.validateAmpJobResult(
      { runtime: 'amp', ampThreadId: threadId },
      { runtime: 'amp', ampThreadId: otherThreadId },
      '',
    ),
    {
      metadata: { runtime: 'amp', ampErrorCode: 'amp_stream_invalid' },
      errorText: 'Amp completed without returning the thread linked to this conversation.',
    },
  );
  assert.equal(
    __test.validateAmpJobResult(
      { runtime: 'amp', ampThreadId: threadId },
      { runtime: 'amp', ampThreadId: threadId },
      '',
    ).metadata.ampThreadId,
    threadId,
  );
});

test('Amp capability reports are bounded before reaching browsers', () => {
  assert.deepEqual(__test.ampRuntimeFromMessage({ amp: {
    id: 'amp',
    available: false,
    version: '0.0.test',
    reason: 'amp_not_authenticated',
    project: { name: 'must not survive while unavailable' },
    secret: 'nope',
  } }), {
    id: 'amp',
    available: false,
    version: '0.0.test',
    reason: 'amp_not_authenticated',
    project: null,
  });
  assert.equal(__test.ampRuntimeFromMessage({ amp: { id: 'other' } }), null);
});

test('daemon runtime capability reports expose only the supported bounded registry', () => {
  assert.deepEqual(__test.executionRuntimesFromMessage({
    claude: { id: 'claude', label: 'Claude', available: true, secret: 'nope' },
    codex: { id: 'codex', label: 'Codex', available: false, reason: 'codex_not_installed', headers: { authorization: 'nope' } },
    amp: { id: 'amp', label: 'Amp', available: false, reason: 'amp_project_unmatched' },
    arbitrary: { id: 'arbitrary', available: true },
  }), {
    claude: { id: 'claude', label: 'Claude', available: true, version: '', reason: null },
    codex: { id: 'codex', label: 'Codex', available: false, version: '', reason: 'codex_not_installed' },
    amp: { id: 'amp', available: false, version: '', reason: 'amp_project_unmatched', project: null, label: 'Amp' },
  });
});
