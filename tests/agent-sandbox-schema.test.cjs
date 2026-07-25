'use strict';

// Agent Sandbox Execution — Phase 0 source-contract + payload tests.
// These assert the schema columns exist (inline DDL, the one that runs on fly.dev)
// and that agentRuntimePayload passes the sandbox fields through to the daemon.

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

test('server inline DDL adds sandbox columns', async () => {
  const src = await readFile(path.join(root, 'server/index.cjs'), 'utf8');
  assert.match(src, /ADD COLUMN IF NOT EXISTS sandbox_provider text/);
  assert.match(src, /ADD COLUMN IF NOT EXISTS sandbox_config jsonb/);
});

test('agentRuntimePayload passes sandbox fields through', async () => {
  const { __test } = require('../server/index.cjs');
  const p = __test.agentRuntimePayload({
    id: 'a', workspace_id: 'w', name: 'S', handle: 's',
    run_mode: 'sandbox', sandbox_provider: 'e2b',
    sandbox_config: JSON.stringify({ template: 'base' }),
  });
  assert.equal(p.run_mode, 'sandbox');
  assert.equal(p.sandbox_provider, 'e2b');
  assert.deepEqual(p.sandbox_config, { template: 'base' });
});

test('resolveRunTarget routes sandbox to the daemon dispatch path', async () => {
  const { __test } = require('../server/index.cjs');
  assert.equal(__test.resolveRunTarget({ run_mode: 'builtin' }), 'builtin');
  assert.equal(__test.resolveRunTarget({ run_mode: 'daemon' }), 'daemon');
  assert.equal(__test.resolveRunTarget({ run_mode: 'sandbox' }), 'daemon');
  assert.equal(__test.resolveRunTarget({}), 'builtin');
});

test('AgentsWindowContent offers a Sandbox runtime option', async () => {
  const src = await readFile(path.join(root, 'src/components/windows/AgentsWindowContent.tsx'), 'utf8');
  assert.match(src, /'builtin' \| 'daemon' \| 'sandbox'/);
  assert.match(src, /value="sandbox"/);
  assert.match(src, /Advanced/);
});

// An MCP-registered agent must NEVER be served by the builtin lane.
//
// Regression this pins: register_agent used to create the workspace_agents row
// with run_mode 'builtin', so DMing that agent was answered by the workspace's
// own Anthropic key WEARING THE AGENT'S NAME. Confirmed live — the reply was
// indistinguishable from the registered client, which is worse than silence
// because a human acts on it. 'external' keeps it out of that branch; when no
// MCP client is polling, runAgentTurn queues the turn and posts a notice that
// explicitly attributes itself to agensis rather than to the agent.
test('resolveRunTarget keeps an external (MCP-registered) agent out of the builtin lane', async () => {
  const { __test } = require('../server/index.cjs');
  assert.equal(__test.resolveRunTarget({ run_mode: 'external' }), 'external');
  // Must not be lumped in with daemon either — there is no daemon CLI to reach.
  assert.notEqual(__test.resolveRunTarget({ run_mode: 'external' }), 'daemon');
  assert.notEqual(__test.resolveRunTarget({ run_mode: 'external' }), 'builtin');
  // The other modes are unchanged.
  assert.equal(__test.resolveRunTarget({ run_mode: 'builtin' }), 'builtin');
  assert.equal(__test.resolveRunTarget({ run_mode: 'daemon' }), 'daemon');
  assert.equal(__test.resolveRunTarget({ run_mode: 'sandbox' }), 'daemon');
  assert.equal(__test.resolveRunTarget({}), 'builtin');
});
