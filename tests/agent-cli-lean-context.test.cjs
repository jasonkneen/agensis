'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let agentTest;

test.before(async () => {
  ({ __test: agentTest } = await import('../agent/agensis-cli/src/agensis.mjs'));
});

function config(overrides = {}) {
  return agentTest.normalizeConfig({
    url: 'https://agents.example.test',
    token: 'aga_secret_token',
    workspace: 'workspace-1',
    agent: 'agent-1',
    ...overrides,
  });
}

function job() {
  return {
    id: 'job-1',
    workspaceId: 'workspace-1',
    sessionId: 'session-1',
    agent: { model: 'claude-opus-4-8', permission_mode: 'default', run_mode: 'daemon' },
  };
}

test('daemon defaults to two concurrent coding CLI processes', () => {
  assert.equal(config().maxConcurrency, 2);
});

test('Claude jobs exclude user customizations and load only the Agensis MCP', () => {
  const command = agentTest.buildAgentCommand(config({ codingCmd: 'claude -p' }), job());
  assert.equal(command.cmd, 'claude');
  assert.deepEqual(command.args.slice(0, 3), ['-p', '--model', 'claude-opus-4-8']);
  assert.ok(command.args.includes('--no-session-persistence'));
  assert.ok(command.args.includes('--safe-mode'));
  const mcpIndex = command.args.indexOf('--mcp-config');
  const mcp = JSON.parse(command.args[mcpIndex + 1]);
  assert.equal(mcp.mcpServers.agensis.url, 'https://agents.example.test/backend/mcp');
  assert.equal(mcp.mcpServers.agensis.headers.Authorization, 'Bearer ${AGENSIS_MCP_TOKEN}');
  assert.ok(command.args.includes('--strict-mcp-config'));
  assert.equal(command.env.AGENSIS_MCP_TOKEN, 'aga_secret_token');
  assert.doesNotMatch(command.args.join(' '), /aga_secret_token/);
});

test('Codex jobs ignore user config, memory, plugins, hooks, and skills', () => {
  const command = agentTest.buildAgentCommand(
    config({ codingCmd: 'codex exec', model: 'gpt-5.6-sol' }),
    { ...job(), agent: { model: 'gpt-5.6-sol', permission_mode: 'default', run_mode: 'daemon' } },
  );
  assert.equal(command.cmd, 'codex');
  for (const flag of ['--ephemeral', '--ignore-user-config', '--ignore-rules']) {
    assert.ok(command.args.includes(flag), `missing ${flag}`);
  }
  for (const feature of ['plugins', 'memories', 'hooks', 'skill_search']) {
    const pair = command.args.some((arg, index) => arg === '--disable' && command.args[index + 1] === feature);
    assert.equal(pair, true, `missing --disable ${feature}`);
  }
  assert.ok(command.args.includes('mcp_servers.agensis.url="https://agents.example.test/backend/mcp"'));
  assert.ok(command.args.includes('mcp_servers.agensis.bearer_token_env_var="AGENSIS_MCP_TOKEN"'));
  assert.ok(command.args.includes('project_doc_max_bytes=0'));
  assert.equal(command.env.AGENSIS_MCP_TOKEN, 'aga_secret_token');
  assert.doesNotMatch(command.args.join(' '), /aga_secret_token/);
});

test('full CLI context remains an explicit compatibility opt-out', () => {
  const claude = agentTest.buildAgentCommand(config({ codingCmd: 'claude -p', fullCliContext: true }), job());
  assert.equal(claude.args.includes('--safe-mode'), false);
  assert.equal(claude.args.includes('--strict-mcp-config'), false);
  const codex = agentTest.buildAgentCommand(config({ codingCmd: 'codex exec', fullCliContext: true }), job());
  assert.equal(codex.args.includes('--ignore-user-config'), false);
  assert.equal(codex.args.includes('--ephemeral'), false);
});

test('lean daemon prompt has a hard complete-prompt budget and preserves the newest request', async () => {
  const prompt = await agentTest.buildPrompt(config(), {
    ...job(),
    prompt: `old ${'a'.repeat(20_000)}\n\nLATEST REQUEST: keep this`,
    agent: {
      ...job().agent,
      system_prompt: 's'.repeat(20_000),
      instructions: 'i'.repeat(20_000),
    },
  });
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= agentTest.LEAN_PROMPT_MAX_BYTES);
  assert.match(prompt, /^\[\.\.\. older or optional Agensis context omitted/);
  assert.match(prompt, /LATEST REQUEST: keep this/);
  assert.match(prompt, /Identity boundary:/);
});

test('local CLI runner passes Agensis-only environment overrides to the child', async () => {
  const { runCli } = await import('../agent/agensis-cli/src/cli.mjs');
  const result = await runCli({
    cmd: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.AGENSIS_MCP_TOKEN || "missing")'],
    env: { AGENSIS_MCP_TOKEN: 'aga_child_only' },
    heartbeatMs: 0,
  });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'aga_child_only');
});

test('daemon job launches the real lean argv, environment, and bounded prompt', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agensis-lean-cli-'));
  const fakeClaude = path.join(tempDir, 'claude.mjs');
  try {
    await fs.writeFile(fakeClaude, [
      '#!/usr/bin/env node',
      'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), token: process.env.AGENSIS_MCP_TOKEN || "" }));',
    ].join('\n'), { mode: 0o700 });
    const sent = [];
    await agentTest.runAgentJob(config({ codingCmd: fakeClaude, cwd: tempDir }), {
      ...job(),
      prompt: `LATEST ${'x'.repeat(30_000)}`,
      ws: { readyState: 1, send: (payload) => sent.push(JSON.parse(payload)) },
    }, { signal: new AbortController().signal });
    const result = sent.find((message) => message.action === 'agent_job_result');
    assert.ok(result, 'missing daemon result');
    const launched = JSON.parse(result.response);
    assert.ok(launched.argv.includes('--safe-mode'));
    assert.ok(launched.argv.includes('--strict-mcp-config'));
    assert.equal(launched.token, 'aga_secret_token');
    assert.ok(Buffer.byteLength(launched.argv.at(-1), 'utf8') <= agentTest.LEAN_PROMPT_MAX_BYTES);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
