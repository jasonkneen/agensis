'use strict';

// Agent Sandbox Execution — the Executor seam. LocalExecutor preserves today's
// behavior (spawn on the host); SandboxExecutor runs the same {cmd,args} inside a
// remote sandbox via an injected provider; createExecutor picks one by run_mode.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');

const load = () =>
  import(pathToFileURL(path.resolve(__dirname, '../agent/agensis-cli/src/executor.mjs')).href);

test('LocalExecutor forwards opts to the runner and returns its result', async () => {
  const { createLocalExecutor } = await load();
  const seen = [];
  const fakeRun = async (opts) => { seen.push(opts); return { status: 0, stdout: 'ok', stderr: '', error: null }; };
  const ex = createLocalExecutor({ run: fakeRun });
  const res = await ex.run({ cmd: 'claude', args: ['-p', 'hi'], cwd: '/tmp' });
  assert.equal(res.stdout, 'ok');
  assert.equal(seen[0].cmd, 'claude');
  assert.deepEqual(seen[0].args, ['-p', 'hi']);
});

test('createExecutor picks LocalExecutor for builtin/daemon', async () => {
  const { createExecutor } = await load();
  const ex = createExecutor({ agent: { run_mode: 'daemon' } });
  assert.equal(typeof ex.run, 'function');
});

function fakeProvider(overrides = {}) {
  const calls = [];
  const p = {
    calls,
    ensureEnv: async () => { calls.push('ensureEnv'); return { id: 'sbx' }; },
    putRepo: async () => { calls.push('putRepo'); },
    exec: async (_h, { onData }) => { calls.push('exec'); onData?.('streamed '); onData?.('tokens'); return { status: 0, stdout: 'streamed tokens', stderr: '', error: null }; },
    getResult: async () => { calls.push('getResult'); return { patch: 'diff --git a b' }; },
    destroy: async () => { calls.push('destroy'); },
    ...overrides,
  };
  return p;
}

test('SandboxExecutor runs the provider lifecycle in order and folds the diff into stdout', async () => {
  const { createSandboxExecutor } = await load();
  const streamed = [];
  const p = fakeProvider();
  const ex = createSandboxExecutor(p);
  const res = await ex.run({ cmd: 'claude', args: ['-p', 'go'], onData: (c) => streamed.push(c) });
  assert.deepEqual(p.calls, ['ensureEnv', 'putRepo', 'exec', 'getResult', 'destroy']);
  assert.deepEqual(streamed, ['streamed ', 'tokens']);
  assert.match(res.stdout, /streamed tokens/);
  assert.match(res.stdout, /```diff\ndiff --git a b\n```/);
  assert.equal(res.status, 0);
});

test('SandboxExecutor always destroys the sandbox, even when exec throws', async () => {
  const { createSandboxExecutor } = await load();
  const p = fakeProvider({ exec: async () => { throw new Error('boom'); } });
  const ex = createSandboxExecutor(p);
  const res = await ex.run({ cmd: 'claude', args: [] });
  assert.ok(p.calls.includes('destroy'));
  assert.match(res.error.message, /boom/);
  assert.equal(res.status, null);
});

test('createExecutor builds a SandboxExecutor for run_mode sandbox using makeProvider', async () => {
  const { createExecutor } = await load();
  let built = 0;
  const provider = fakeProvider();
  const ex = createExecutor(
    { agent: { run_mode: 'sandbox', sandbox_provider: 'e2b', sandbox_config: {} } },
    { makeProvider: () => { built++; return provider; } },
  );
  await ex.run({ cmd: 'claude', args: [] });
  assert.equal(built, 1);
  assert.ok(provider.calls.includes('ensureEnv'));
});
