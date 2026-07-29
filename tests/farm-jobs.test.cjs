'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

function makeDb(handlers = []) {
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ sql: normalized, params });
      const handler = handlers.find((item) => item.match.test(normalized));
      return handler ? (typeof handler.rows === 'function' ? handler.rows(params) : handler.rows) : [];
    },
  };
  return db;
}

test.afterEach(() => __test.resetTestState());

test('Farm dispatch creates a sessionless job and sends it to the selected daemon', async () => {
  const sent = [];
  const connection = { connectionId: 'connection-1', ws: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) } };
  const db = makeDb([
    { match: /select \* from workspace_agents/, rows: [{ id: 'agent-1', workspace_id: 'workspace-1', name: 'Coder', handle: 'coder', model: 'auto', run_mode: 'daemon', enabled: true }] },
    { match: /insert into agent_jobs/, rows: (params) => [{ id: 'job-1', workspace_id: params[0], agent_id: params[1], connection_id: params[2], session_id: null, prompt: params[3], status: 'running', metadata: params[4] }] },
  ]);
  __test.setTestDb(db);

  const job = await __test.dispatchFarmAgentJob({ workspaceId: 'workspace-1', agentId: 'agent-1', prompt: 'Fix the build', connection });
  assert.equal(job.id, 'job-1');
  assert.equal(job.sessionId, null);
  assert.equal(sent[0].type, 'agent_job');
  assert.equal(sent[0].job.prompt, 'Fix the build');
  assert.equal(sent[0].job.sessionId, null);
});

test('Farm dispatch rejects a connected daemon that does not advertise coding support', async () => {
  const connection = { connectionId: 'connection-1', capabilities: { codingRoute: false }, ws: { readyState: 1, send: () => {} } };
  const db = makeDb([
    { match: /select \* from workspace_agents/, rows: [{ id: 'agent-1', workspace_id: 'workspace-1', name: 'Shared only', handle: 'shared', model: 'auto', run_mode: 'daemon', enabled: true }] },
  ]);
  __test.setTestDb(db);
  await assert.rejects(
    () => __test.dispatchFarmAgentJob({ workspaceId: 'workspace-1', agentId: 'agent-1', prompt: 'work', connection }),
    /does not advertise coding support/i,
  );
  assert.equal(db.calls.some((call) => /insert into agent_jobs/.test(call.sql)), false);
});

test('production capability sync updates the live connection used by Farm dispatch', async () => {
  const ws = { readyState: 1, send: () => {}, agentAuth: { workspaceId: 'workspace-1', agentId: 'agent-1' }, workspaceId: 'workspace-1', agentId: 'agent-1', agentConnectionId: 'connection-1' };
  const db = makeDb([
    { match: /update agent_connections set capabilities/, rows: [{ id: 'connection-1', workspace_id: 'workspace-1', agent_id: 'agent-1', capabilities: '{}' }] },
    { match: /select \* from workspace_agents/, rows: [{ id: 'agent-1', workspace_id: 'workspace-1', name: 'Shared only', handle: 'shared', model: 'auto', run_mode: 'daemon', enabled: true }] },
  ]);
  __test.setTestDb(db);
  __test.registerTestConnectedAgent({ ws, connectionId: 'connection-1', workspaceId: 'workspace-1', agentId: 'agent-1', handle: 'shared', name: 'Shared only' });
  await __test.handleAgentCapabilitiesSync(ws, { codingRoute: false, shared: true, sharedModels: [{ id: 'qwen', shared: true }] });
  await assert.rejects(
    () => __test.dispatchFarmAgentJob({ workspaceId: 'workspace-1', agentId: 'agent-1', prompt: 'work' }),
    /does not advertise coding support/i,
  );
});

test('finalizing a Farm job updates the job without writing a chat message', async () => {
  const db = makeDb([{ match: /update agent_jobs set status = \$2/, rows: [{ id: 'job-1', status: 'done' }] }]);
  __test.setTestDb(db);
  await __test.finalizeAgentJobResult({ id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', session_id: null, metadata: JSON.stringify({ mode: 'farm' }) }, { responseText: 'Complete' });
  assert.equal(db.calls.some((call) => /insert into messages|update messages/.test(call.sql)), false);
});

test('Farm cancellation marks the job and asks the daemon to abort the exact job', async () => {
  const sent = [];
  const connection = { connectionId: 'connection-1', ws: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) } };
  const db = makeDb([
    { match: /select \* from agent_jobs/, rows: [{ id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', connection_id: 'connection-1', status: 'running', metadata: JSON.stringify({ mode: 'farm' }) }] },
    { match: /update agent_jobs set status = 'cancelled'/, rows: [{ id: 'job-1', status: 'cancelled' }] },
  ]);
  __test.setTestDb(db);
  const result = await __test.cancelFarmAgentJob({ workspaceId: 'workspace-1', jobId: 'job-1', connection });
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(sent[0], { type: 'agent_job_cancel', jobId: 'job-1', reason: 'Cancelled by Farm' });
});

test('Farm job deltas update the pollable job without requiring a chat placeholder', async () => {
  const db = makeDb([
    { match: /select j\.\*, a\.name as agent_name/, rows: [{ id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', session_id: null, metadata: JSON.stringify({ mode: 'farm' }) }] },
    { match: /update agent_jobs set response/, rows: [] },
  ]);
  __test.setTestDb(db);
  await __test.handleAgentJobDelta({ agentAuth: { workspaceId: 'workspace-1', agentId: 'agent-1', name: 'Coder' }, agentConnectionId: 'connection-1' }, { jobId: 'job-1', content: 'working', elapsedMs: 1200 });
  assert.equal(db.calls.some(call => /update agent_jobs set response/.test(call.sql)), true);
  assert.equal(db.calls.some(call => /update messages/.test(call.sql)), false);
});

test('a cancellation committed during finalization cannot be overwritten by a late result', async () => {
  const db = makeDb([
    { match: /update agent_jobs set status = \$2/, rows: [] },
  ]);
  __test.setTestDb(db);
  const result = await __test.finalizeAgentJobResult(
    { id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', session_id: null, metadata: JSON.stringify({ mode: 'farm' }) },
    { responseText: 'too late' },
  );
  assert.equal(result, null);
  assert.match(db.calls[0].sql, /status in \('queued', 'running'\)/);
});

test('Farm cancellation returns the winning terminal result when completion commits first', async () => {
  const sent = [];
  let reads = 0;
  const connection = { connectionId: 'connection-1', ws: { readyState: 1, send: (value) => sent.push(JSON.parse(value)) } };
  const db = makeDb([
    { match: /select \* from agent_jobs/, rows: () => {
      reads += 1;
      return [{ id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', status: reads === 1 ? 'running' : 'done', response: reads === 1 ? '' : 'finished', metadata: JSON.stringify({ mode: 'farm' }) }];
    } },
    { match: /update agent_jobs set status = 'cancelled'/, rows: [] },
  ]);
  __test.setTestDb(db);
  const result = await __test.cancelFarmAgentJob({ workspaceId: 'workspace-1', jobId: 'job-1', connection });
  assert.equal(result.status, 'done');
  assert.equal(result.response, 'finished');
  assert.equal(sent.length, 0);
});

test('Farm cancellation targets the exact connection that accepted the job', async () => {
  const first = [];
  const second = [];
  const db = makeDb([
    { match: /select \* from agent_jobs/, rows: [{ id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', connection_id: 'connection-b', status: 'running', metadata: JSON.stringify({ mode: 'farm' }) }] },
    { match: /update agent_jobs set status = 'cancelled'/, rows: [{ id: 'job-1', status: 'cancelled' }] },
  ]);
  __test.setTestDb(db);
  __test.registerTestConnectedAgent({ connectionId: 'connection-a', workspaceId: 'workspace-1', agentId: 'agent-1', ws: { readyState: 1, send: (value) => first.push(JSON.parse(value)) } });
  __test.registerTestConnectedAgent({ connectionId: 'connection-b', workspaceId: 'workspace-1', agentId: 'agent-1', ws: { readyState: 1, send: (value) => second.push(JSON.parse(value)) } });
  await __test.cancelFarmAgentJob({ workspaceId: 'workspace-1', jobId: 'job-1' });
  assert.equal(first.some((message) => message.type === 'agent_job_cancel'), false);
  assert.equal(second.some((message) => message.type === 'agent_job_cancel'), true);
});

test('Farm jobs use a long stale-progress timeout instead of the four-minute chat timeout', async () => {
  const db = makeDb([]);
  __test.setTestDb(db);
  await __test.reapStuckAgentJobs();
  const query = db.calls.find((call) => /select \* from agent_jobs where status = 'running'/.test(call.sql));
  assert.match(query.sql, /updated_at/);
  // The three windows are named constants bound as parameters now (idle,
  // hard ceiling, farm ceiling) rather than literals inlined in the SQL — the
  // idle one has to stay paired with the daemon's 9-minute deadline, which a
  // magic number buried in a query string cannot express.
  assert.match(query.sql, /make_interval\(mins => \$3::int\)/);
  assert.deepEqual(query.params, [10, 30, 31]);
});

test('late Farm deltas are ignored after cancellation wins the status transition', async () => {
  const db = makeDb([
    { match: /select j\.\*, a\.name as agent_name/, rows: [{ id: 'job-1', workspace_id: 'workspace-1', agent_id: 'agent-1', session_id: null, metadata: JSON.stringify({ mode: 'farm', responseMessageId: 'message-1' }) }] },
    { match: /update agent_jobs set response/, rows: [] },
  ]);
  __test.setTestDb(db);
  await __test.handleAgentJobDelta(
    { agentAuth: { workspaceId: 'workspace-1', agentId: 'agent-1', name: 'Coder' }, agentConnectionId: 'connection-1' },
    { jobId: 'job-1', content: 'too late' },
  );
  const update = db.calls.find((call) => /update agent_jobs set response/.test(call.sql));
  assert.match(update.sql, /status in \('queued', 'running'\)/);
  assert.equal(db.calls.some((call) => /update messages/.test(call.sql)), false);
});

test('revoking a Farm integration disables and disconnects all of its child agents', async () => {
  const sent = [];
  let closed = false;
  const ws = {
    readyState: 1,
    agentConnectionId: 'connection-1',
    agentId: 'agent-1',
    send: (value) => sent.push(JSON.parse(value)),
    close: () => { closed = true; },
  };
  const db = makeDb([
    { match: /update workspace_agents set enabled = false/, rows: [{ id: 'agent-1', workspace_id: 'workspace-1', name: 'Child', metadata: JSON.stringify({ farmIntegrationId: 'farm-1' }) }] },
    { match: /update agent_connections set status = 'offline'/, rows: [{ id: 'connection-1', workspace_id: 'workspace-1', agent_id: 'agent-1', status: 'offline' }] },
  ]);
  __test.setTestDb(db);
  __test.registerTestConnectedAgent({ ws, connectionId: 'connection-1', workspaceId: 'workspace-1', agentId: 'agent-1', handle: 'child', name: 'Child' });
  const disabled = await __test.disableFarmIntegrationAgents('workspace-1', 'farm-1');
  assert.equal(disabled.length, 1);
  assert.equal(closed, true);
  assert.deepEqual(sent.find((message) => message.type === 'agent_disabled'), { type: 'agent_disabled', reason: 'deactivated' });
});
