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
