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
