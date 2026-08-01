'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { __test: mcpTest } = require('../server/mcp.cjs');

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

test('mint without manage proof cannot escalate permission_mode to yolo', async () => {
 // An agent re-minting its own connect token must keep the stored mode.
 // MUTATION: apply permissionMode without allowPermissionModeChange -> fails.
 const db = makeDb();
 __test.setTestDb(db);
 const payload = await __test.buildAgentConnectionCommand({
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  permissionMode: 'yolo',
  // no allowPermissionModeChange (agent path)
  baseUrl: 'https://backend.example.test',
 });
 assert.equal(payload.permissionMode, 'default');
 assert.equal(payload.permission_mode, 'default');
 const update = db.calls.find(call => call.normalized.startsWith('update workspace_agents'));
 assert.ok(update);
 assert.equal(update.params[4], 'default', 'permission_mode column must stay at stored mode');
});

test('actorUserId alone must not open the permission_mode gate', async () => {
 // Skeptic: Boolean(actorUserId) was enough to escalate to yolo without manage proof.
 // MUTATION: modeOverrideAllowed includes Boolean(actorUserId) -> fails.
 const db = makeDb();
 __test.setTestDb(db);
 const payload = await __test.buildAgentConnectionCommand({
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  permissionMode: 'yolo',
  allowPermissionModeChange: false,
  actorUserId: 'user-any-1',
  baseUrl: 'https://backend.example.test',
 });
 assert.equal(payload.permissionMode, 'default');
 const update = db.calls.find(call => call.normalized.startsWith('update workspace_agents'));
 assert.equal(update.params[4], 'default');
});

test('manage-proven mint may set permission_mode', async () => {
 const db = makeDb();
 __test.setTestDb(db);
 const payload = await __test.buildAgentConnectionCommand({
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  permissionMode: 'yolo',
  allowPermissionModeChange: true,
  actorUserId: 'user-manage-1',
  baseUrl: 'https://backend.example.test',
 });
 assert.equal(payload.permissionMode, 'yolo');
 const update = db.calls.find(call => call.normalized.startsWith('update workspace_agents'));
 assert.equal(update.params[4], 'yolo');
});

test('MCP agent get_connect_command refuses permission_mode override', async () => {
 // Compromised agent token must not escalate to yolo via the public MCP surface.
 // MUTATION: allow agent kind to pass permission_mode through -> fails.
 // Use runToolForIdentity (not createBuiltinToolset): get_connect_command is
 // deliberately excluded from builtin turns, but remains on the MCP door.
 let captured = null;
 const toolMap = new Map(mcpTest.buildTools().map((t) => [t.name, t]));
 const deps = {
  getAgentConnectionCommand: async (opts) => {
   captured = opts;
   return {
    handle: 'code-handler',
    token: 'aga_test',
    command: 'agensis connect',
    permissionMode: 'default',
   };
  },
 };
 const identity = {
  kind: 'agent',
  agentId: 'agent-1',
  workspaceId: 'workspace-1',
  name: 'Coder',
  handle: 'coder',
 };
 const refused = await mcpTest.runToolForIdentity({
  name: 'get_connect_command',
  args: { permission_mode: 'yolo' },
  identity,
  db: { unsafe: async () => [] },
  deps,
  toolMap,
 });
 assert.equal(refused.ok, false);
 assert.match(String(refused.error || ''), /permission mode|manage-level/i);
 assert.equal(captured, null, 'must not reach the mint helper when agent passes a mode');

 const ok = await mcpTest.runToolForIdentity({
  name: 'get_connect_command',
  args: {},
  identity,
  db: { unsafe: async () => [] },
  deps,
  toolMap,
 });
 assert.equal(ok.ok, true);
 assert.equal(captured.permissionMode, null);
 assert.equal(captured.allowPermissionModeChange, false);
});
