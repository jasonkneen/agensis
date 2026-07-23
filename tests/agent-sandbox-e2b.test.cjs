'use strict';

// e2b provider adapter — the network I/O boundary. Uses --experimental-test-module-mocks
// to replace the real e2b SDK with a fake sandbox, so this test does no network I/O.

const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createRequire } = require('node:module');
const path = require('node:path');

// e2b is a daemon-only dep (agent/agensis-cli/node_modules), not resolvable from
// the repo root where this test lives. Resolve the CLI's copy so mock.module
// targets the exact specifier the adapter imports — no root dependency creep.
const e2bAdapterUrl = pathToFileURL(path.resolve(__dirname, '../agent/agensis-cli/src/sandbox/e2b.mjs')).href;
const e2bSpecifier = createRequire(path.resolve(__dirname, '../agent/agensis-cli/src/sandbox/e2b.mjs')).resolve('e2b');

// Register the mock ONCE — Node's mock.module rejects a second mock of the same
// resolved module. Each test swaps `currentSandbox` for its own fake.
let currentSandbox = null;
test.mock.module(e2bSpecifier, {
  namedExports: { Sandbox: { create: async () => currentSandbox } },
});

test('e2b provider clones the repo, runs the CLI with streamed stdout, reads the diff, and kills', async () => {
  const runCalls = [];
  const runOptions = [];
  let killed = false;
  currentSandbox = {
    commands: {
      run: async (cmd, opts = {}) => {
        runCalls.push(cmd);
        runOptions.push(opts);
        if (/git add -A && git diff/.test(cmd)) return { exitCode: 0, stdout: 'diff --git a b', stderr: '' };
        if (/git clone/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' };
        if (opts.onStdout) { opts.onStdout('hello '); opts.onStdout('world'); }
        return { exitCode: 0, stdout: 'hello world', stderr: '' };
      },
    },
    kill: async () => { killed = true; return true; },
  };
  const mod = await import(e2bAdapterUrl);
  const provider = mod.createE2bProvider({ apiKey: 'k', anthropicApiKey: 'a', repoUrl: 'https://github.com/x/y.git' });

  const streamed = [];
  const handle = await provider.ensureEnv({ job: {} });
  await provider.putRepo(handle, { job: {} });
  const exec = await provider.exec(handle, {
    cmd: 'claude',
    args: ['-p', 'go'],
    env: { AGENSIS_MCP_TOKEN: 'aga_test' },
    onData: (c) => streamed.push(c),
  });
  const result = await provider.getResult(handle, { job: {} });
  await provider.destroy(handle);

  assert.ok(runCalls.some((c) => /git clone/.test(c)), 'expected a git clone');
  assert.ok(runCalls.some((c) => /claude/.test(c)), 'expected the coding CLI to run');
  assert.ok(runOptions.some((opts) => opts.envs?.AGENSIS_MCP_TOKEN === 'aga_test'));
  assert.deepEqual(streamed, ['hello ', 'world']);
  assert.equal(exec.status, 0);
  assert.match(result.patch, /diff --git a b/);
  assert.equal(killed, true);
});

test('e2b provider throws a clear error when apiKey or repoUrl is missing', async () => {
  const mod = await import(e2bAdapterUrl);
  assert.throws(() => mod.createE2bProvider({ apiKey: '', repoUrl: 'https://x/y.git' }), /E2B_API_KEY/);
  assert.throws(() => mod.createE2bProvider({ apiKey: 'k', repoUrl: '' }), /repo URL/);
});

test('e2b provider surfaces a git clone failure as a thrown error', async () => {
  currentSandbox = {
    commands: {
      run: async (cmd) => {
        if (/command -v claude/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' };
        if (/git clone/.test(cmd)) { const e = new Error('command exited with code 128'); e.exitCode = 128; e.stdout = ''; e.stderr = 'fatal: repository not found'; throw e; }
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    kill: async () => true,
  };
  const mod = await import(e2bAdapterUrl);
  const provider = mod.createE2bProvider({ apiKey: 'k', anthropicApiKey: 'a', repoUrl: 'https://github.com/x/y.git' });
  const handle = await provider.ensureEnv({ job: {} });
  await assert.rejects(() => provider.putRepo(handle, { job: {} }), /git clone failed/);
});

// e2b's commands.run THROWS CommandExitError on non-zero exit (the error itself
// carries exitCode/stdout/stderr). A coding CLI failing tests/lint is a normal
// outcome, so exec must preserve those fields, not collapse to status:null.
function commandExitError({ exitCode, stdout = '', stderr = '' }) {
  const e = new Error(`command exited with code ${exitCode}`);
  e.exitCode = exitCode; e.stdout = stdout; e.stderr = stderr;
  return e;
}

test('exec preserves exitCode/stdout when the CLI exits non-zero (CommandExitError)', async () => {
  currentSandbox = {
    commands: {
      run: async (cmd, opts = {}) => {
        if (/command -v claude/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' };
        if (opts.onStdout) opts.onStdout('partial output');
        throw commandExitError({ exitCode: 2, stdout: 'partial output', stderr: 'lint failed' });
      },
    },
    kill: async () => true,
  };
  const mod = await import(e2bAdapterUrl);
  const provider = mod.createE2bProvider({ apiKey: 'k', anthropicApiKey: 'a', repoUrl: 'https://github.com/x/y.git' });
  const handle = await provider.ensureEnv({ job: {} });
  const streamed = [];
  const exec = await provider.exec(handle, { cmd: 'claude', args: ['-p', 'go'], onData: (c) => streamed.push(c) });
  assert.equal(exec.status, 2);
  assert.equal(exec.stdout, 'partial output');
  assert.equal(exec.stderr, 'lint failed');
  assert.equal(exec.error, null);
  assert.deepEqual(streamed, ['partial output']);
});

test('putRepo also fails when git clone RETURNS a non-zero exit (defensive path)', async () => {
  currentSandbox = {
    commands: {
      run: async (cmd) => {
        if (/command -v claude/.test(cmd)) return { exitCode: 0, stdout: '', stderr: '' };
        if (/git clone/.test(cmd)) return { exitCode: 128, stdout: '', stderr: 'fatal: auth failed' };
        return { exitCode: 0, stdout: '', stderr: '' };
      },
    },
    kill: async () => true,
  };
  const mod = await import(e2bAdapterUrl);
  const provider = mod.createE2bProvider({ apiKey: 'k', anthropicApiKey: 'a', repoUrl: 'https://github.com/x/y.git' });
  const handle = await provider.ensureEnv({ job: {} });
  await assert.rejects(() => provider.putRepo(handle, { job: {} }), /git clone failed: fatal: auth failed/);
});
