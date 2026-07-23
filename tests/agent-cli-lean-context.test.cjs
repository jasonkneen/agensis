'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

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
  const settingsIndex = command.args.indexOf('--setting-sources');
  assert.equal(command.args[settingsIndex + 1], 'project,local');
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
  assert.equal(command.env.AGENSIS_MCP_TOKEN, 'aga_secret_token');
  assert.doesNotMatch(command.args.join(' '), /aga_secret_token/);
});

test('full CLI context remains an explicit compatibility opt-out', () => {
  const claude = agentTest.buildAgentCommand(config({ codingCmd: 'claude -p', fullCliContext: true }), job());
  assert.equal(claude.args.includes('--setting-sources'), false);
  assert.equal(claude.args.includes('--strict-mcp-config'), false);
  const codex = agentTest.buildAgentCommand(config({ codingCmd: 'codex exec', fullCliContext: true }), job());
  assert.equal(codex.args.includes('--ignore-user-config'), false);
  assert.equal(codex.args.includes('--ephemeral'), false);
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
