'use strict';

// Reconnect reconciliation (server half): the daemon's agent_register frame may
// carry activeJobIds. A running row it does NOT list was lost with a daemon
// restart and is finalized at once, instead of after the ten-minute reaper. A
// frame without the field (older daemon) must change nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const WORKSPACE = 'ws-1';
const AGENT = 'agent-coder';
const norm = (sql) => String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

function socket() {
  const ws = {
    readyState: 1, isAlive: true, sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
    close() { this.readyState = 3; },
  };
  ws.agentAuth = { workspaceId: WORKSPACE, agentId: AGENT, handle: 'coder', name: 'Coder', agent: { id: AGENT, name: 'Coder', handle: 'coder' } };
  return ws;
}

function fakeDb(jobs) {
  const finalized = [];
  let jobSelects = 0;
  return {
    finalized,
    get jobSelects() { return jobSelects; },
    async begin(work) { return work(this); },
    async unsafe(sql, params = []) {
      const text = norm(sql);
      if (text.startsWith('select id, name, avatar')) {
        return [{ id: AGENT, name: 'Coder', avatar: 'CO', accent_color: '', description: '', soul: '', identity: {}, run_mode: 'daemon', metadata: {}, enabled: true, version: 1 }];
      }
      if (text.startsWith('insert into agent_connections')) {
        const [id, workspace_id, agent_id, name, handle, host, cwd, metadata] = params;
        return [{ id, workspace_id, agent_id, name, handle, host, cwd, status: 'online', metadata, capabilities: {}, connected_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), updated_at: new Date().toISOString() }];
      }
      if (text.startsWith('update agent_jobs set connection_id')) return [];
      if (text.startsWith('select * from agent_jobs where workspace_id')) {
        jobSelects += 1;
        // The SQL itself enforces the 15s grace; the fake mirrors it.
        return jobs.filter((j) => j.status === 'running' && j.ageSeconds >= params[2]);
      }
      if (text.startsWith('update agent_jobs set status')) {
        finalized.push({ id: params[0], error: params[1], metadata: params[2] });
        return [{ id: params[0] }];
      }
      return [];
    },
  };
}

async function register(extra) {
  await __test.registerAgentConnection(socket(), {
    workspaceId: WORKSPACE, agentId: AGENT, handle: 'coder', name: 'Coder', host: 'h', cwd: '/x', ...extra,
  });
  await new Promise((resolve) => setImmediate(resolve));
}

const jobs = () => [
  { id: 'alive', workspace_id: WORKSPACE, agent_id: AGENT, status: 'running', ageSeconds: 600, metadata: {} },
  { id: 'lost', workspace_id: WORKSPACE, agent_id: AGENT, status: 'running', ageSeconds: 600, metadata: {} },
  { id: 'fresh', workspace_id: WORKSPACE, agent_id: AGENT, status: 'running', ageSeconds: 2, metadata: {} },
];

test('a running job the daemon does not list is finalized as lost', async () => {
  const db = fakeDb(jobs());
  __test.setTestDb(db);
  await register({ activeJobIds: ['alive'] });
  assert.deepEqual(db.finalized.map((f) => f.id), ['lost'], 'listed and brand-new jobs are left alone');
  assert.match(db.finalized[0].error, /daemon restarted; the turn was lost/);
  assert.equal(db.finalized[0].metadata.stopReason, 'connection_lost');
});

test('an empty list means every old running job was lost', async () => {
  const db = fakeDb(jobs());
  __test.setTestDb(db);
  await register({ activeJobIds: [] });
  assert.deepEqual(db.finalized.map((f) => f.id).sort(), ['alive', 'lost']);
});

test('an older daemon (no activeJobIds) leaves every job alone', async () => {
  const db = fakeDb(jobs());
  __test.setTestDb(db);
  await register({});
  assert.equal(db.jobSelects, 0, 'no reconciliation query at all');
  assert.deepEqual(db.finalized, []);
});
