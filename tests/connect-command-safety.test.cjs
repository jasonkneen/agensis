'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

function makeDb() {
 const calls = [];
 const original = {
  id: 'agent-1',
  workspace_id: 'workspace-1',
  name: 'Code handler',
  handle: 'code-handler',
  model: 'auto',
  run_mode: 'builtin',
  permission_mode: 'default',
  enabled: true,
  mcp_approved: true,
  purpose: 'resource',
  resource_facets: ['code'],
  controller_id: 'controller-1',
  connect_token_hash: 'HASH-MUST-NOT-LEAVE',
  metadata: { host_folders: ['/private/repo'], sandbox_skills: [{ name: 'secret' }] },
  sandbox_config: { allow: 'everything' },
  identity: { api_key: 'MUST-NOT-LEAVE' },
  memory_dir: '/private/memory',
 };
 const db = {
  calls,
  async unsafe(sql, params = []) {
   const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   calls.push({ normalized, params });
   if (normalized.startsWith('select * from workspace_agents')) return [{ ...original }];
   if (normalized.startsWith('update workspace_agents')) {
    return [{ ...original, handle: params[1], model: params[3], permission_mode: params[4], run_mode: 'daemon' }];
   }
   if (normalized.startsWith('insert into audit_log')) return [{ id: 'audit-1', seq: 1, entry_hash: 'a'.repeat(64) }];
   return [];
  },
 };
 return db;
}

test.afterEach(() => __test.resetTestState());

test('connection-command response is a safe projection and controller mint is attributed', async () => {
 const db = makeDb();
 __test.setTestDb(db);
 const payload = await __test.buildAgentConnectionCommand({
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  baseUrl: 'https://backend.example.test',
  actorControllerId: 'controller-1',
 });
 assert.equal(payload.agent.id, 'agent-1');
 assert.equal(payload.agent.controller_id, 'controller-1');
 assert.equal('connect_token_hash' in payload.agent, false);
 assert.equal('metadata' in payload.agent, false);
 assert.equal('sandbox_config' in payload.agent, false);
 assert.equal('identity' in payload.agent, false);
 assert.equal('memory_dir' in payload.agent, false);
 assert.match(payload.token, /^aga_/);
 const audit = db.calls.find(call => call.normalized.startsWith('insert into audit_log'));
 assert.ok(audit);
 assert.equal(audit.params[3], 'controller:controller-1');
 assert.equal(audit.params[4], 'agent.connect_token_minted');
 assert.equal(JSON.stringify(audit.params).includes('HASH-MUST-NOT-LEAVE'), false);
});
