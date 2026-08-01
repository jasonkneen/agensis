'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

const { mountSchedulesRoutes } = require('../server/schedules-routes.cjs');
const {
 lockScheduleExecutionScope,
 lockScheduleScope,
 scheduleAgentMatchesSession,
} = require('../server/schedule-scope.cjs');
const {
 roleHasWorkspaceCapability,
 sessionReadableSql,
} = require('../shared/backend-core.cjs');
const { __test } = require('../server/index.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const SCHEDULE = '44444444-4444-4444-8444-444444444444';
const AGENT = '55555555-5555-4555-8555-555555555555';
const OTHER_AGENT = '77777777-7777-4777-8777-777777777777';

function scheduleRow(overrides = {}) {
 return {
  id: SCHEDULE,
  workspace_id: WORKSPACE,
  session_id: SESSION,
  agent_id: AGENT,
  created_by: USER,
  name: 'Daily check',
  prompt: 'Check the build',
  interval_seconds: 3600,
  enabled: true,
  running: true,
  ...overrides,
 };
}

function sessionRow() {
 return {
  id: SESSION,
  workspace_id: WORKSPACE,
  visibility: 'private',
  folder: 'Direct messages',
  participants: [{
   kind: 'agent',
   agent_id: AGENT,
   handle: 'scheduled-agent',
   direct: true,
  }],
  deleted_at: null,
 };
}

test('scheduled agents must be roster participants and the exact DM target', () => {
 assert.equal(scheduleAgentMatchesSession(sessionRow(), AGENT), true);
 assert.equal(scheduleAgentMatchesSession(sessionRow(), OTHER_AGENT), false);
 assert.equal(scheduleAgentMatchesSession({
  ...sessionRow(),
  folder: 'Channels',
  participants: [
   { kind: 'agent', agent_id: AGENT },
   { kind: 'agent', agent_id: OTHER_AGENT },
  ],
 }, OTHER_AGENT), true);
 assert.equal(scheduleAgentMatchesSession({
  ...sessionRow(),
  participants: [
   { kind: 'agent', agent_id: AGENT, direct: true },
   { kind: 'agent', agent_id: OTHER_AGENT },
  ],
 }, OTHER_AGENT), false);
});

test('forced schedule dispatch selects by exact id, never by a duplicate handle', () => {
 const agents = [
  { id: AGENT, handle: 'duplicate', enabled: true },
  { id: OTHER_AGENT, handle: 'duplicate', enabled: true },
 ];
 assert.equal(
  __test.explicitConversationAgent(agents, new Set([AGENT, OTHER_AGENT]), OTHER_AGENT)?.id,
  OTHER_AGENT,
 );
 assert.equal(
  __test.explicitConversationAgent(agents, new Set([AGENT]), OTHER_AGENT),
  null,
 );
 assert.equal(
  __test.explicitConversationAgent(
   [{ id: OTHER_AGENT, handle: 'duplicate', enabled: false }],
   new Set([OTHER_AGENT]),
   OTHER_AGENT,
  ),
  null,
 );
});

test('schedule scope locks role lineage, private membership, session, then schedule', async () => {
 const calls = [];
 const tx = {
  async unsafe(sql, params = []) {
   const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   calls.push({ sql: q, params });
   if (q.startsWith('with recursive schedule_workspace_chain')) {
    return [{ id: WORKSPACE, user_id: USER, role: null }];
   }
   if (q.startsWith('select schedule_session_scope.id')) return [sessionRow()];
   if (q.startsWith('select * from agent_schedules schedule_scope')) return [scheduleRow()];
   throw new Error(`Unexpected schedule scope query: ${sql}`);
  },
 };

 const result = await lockScheduleScope({
  tx,
  userId: USER,
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  scheduleId: SCHEDULE,
  capability: 'run_agents',
  roleHasWorkspaceCapability,
  sessionReadableSql,
 });

 assert.equal(result.schedule.id, SCHEDULE);
 assert.equal(calls.length, 3);
 assert.match(calls[0].sql, /for share of workspace/);
 assert.match(calls[0].sql, /for share of membership/);
 assert.match(calls[1].sql, /schedule_session_scope\.deleted_at is null/);
 assert.match(calls[1].sql, /chat_session_members csm/);
 assert.match(calls[1].sql, /for share/);
 assert.match(calls[1].sql, /for share of schedule_session_scope/);
 assert.match(calls[2].sql, /for update of schedule_scope/);
});

test('a role revoke or private membership revoke stops before the schedule row is touched', async (t) => {
 await t.test('workspace capability revoked', async () => {
  const calls = [];
  await assert.rejects(
   lockScheduleScope({
    tx: {
     async unsafe(sql) {
      calls.push(String(sql));
      return [{ id: WORKSPACE, user_id: 'someone-else', role: 'viewer' }];
     },
    },
    userId: USER,
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    scheduleId: SCHEDULE,
    capability: 'run_agents',
    roleHasWorkspaceCapability,
    sessionReadableSql,
   }),
   error => error?.status === 403 && /workspace access changed/i.test(error.message),
  );
  assert.equal(calls.length, 1);
 });

 await t.test('private membership revoked', async () => {
  const calls = [];
  await assert.rejects(
   lockScheduleScope({
    tx: {
     async unsafe(sql) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push(q);
      if (q.startsWith('with recursive schedule_workspace_chain')) {
       return [{ id: WORKSPACE, user_id: USER, role: null }];
      }
      if (q.startsWith('select schedule_session_scope.id')) return [];
      throw new Error('the schedule row must not be reached after membership revoke');
     },
    },
    userId: USER,
    workspaceId: WORKSPACE,
    sessionId: SESSION,
    scheduleId: SCHEDULE,
    capability: 'run_agents',
    roleHasWorkspaceCapability,
    sessionReadableSql,
   }),
   error => error?.status === 403 && /conversation access changed/i.test(error.message),
  );
  assert.equal(calls.length, 2);
 });
});

test('execution locks the selected agent before the schedule and revalidates its identity', async () => {
 const calls = [];
 const tx = {
  async unsafe(sql) {
   const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   calls.push(q);
   if (q.startsWith('with recursive schedule_workspace_chain')) {
    return [{ id: WORKSPACE, user_id: USER, role: null }];
   }
   if (q.startsWith('select schedule_session_scope.id')) return [sessionRow()];
   if (q.startsWith('select * from workspace_agents schedule_agent_scope')) {
    return [{ id: AGENT, workspace_id: WORKSPACE, enabled: true }];
   }
   if (q.startsWith('select * from agent_schedules schedule_scope')) return [scheduleRow()];
   throw new Error(`Unexpected execution scope query: ${sql}`);
  },
 };
 const result = await lockScheduleExecutionScope({
  tx,
  userId: USER,
  workspaceId: WORKSPACE,
  sessionId: SESSION,
  scheduleId: SCHEDULE,
  agentId: AGENT,
  capability: 'run_agents',
  roleHasWorkspaceCapability,
  sessionReadableSql,
 });
 assert.equal(result.agent.id, AGENT);
 assert.equal(calls.length, 4);
 assert.match(calls[2], /workspace_agents schedule_agent_scope/);
 assert.match(calls[2], /for share of schedule_agent_scope/);
 assert.match(calls[3], /agent_schedules schedule_scope/);
 assert.match(calls[3], /for update of schedule_scope/);
});

async function withScheduleServer({ lockedSessionRows = [] }, run) {
 const mutations = [];
 const notifications = [];
 let runnerCalls = 0;
 const db = {
  async unsafe(sql) {
   const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   if (q.startsWith('select * from agent_schedules where id =')) return [scheduleRow()];
   if (q.startsWith('select 1 from workspace_agents')) return [{ ok: 1 }];
   if (q.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')) {
    return [sessionRow()];
   }
   throw new Error(`Unexpected schedule preflight query: ${sql}`);
  },
  async begin(callback) {
   return callback({
    unsafe: async (sql) => {
     const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
     if (q.startsWith('with recursive schedule_workspace_chain')) {
      return [{ id: WORKSPACE, user_id: USER, role: null }];
     }
     if (q.startsWith('select schedule_session_scope.id')) return lockedSessionRows;
     if (/^(insert|update|delete)\b/.test(q)) mutations.push(q);
     throw new Error(`Mutation reached after schedule scope disappeared: ${sql}`);
    },
   });
  },
 };
 const app = express();
 app.use(express.json());
 mountSchedulesRoutes(app, {
  requireAuth(req, _res, next) {
   req.userId = USER;
   next();
  },
  jsonError(res, status, error) {
   res.status(status).json({ data: null, error: { message: error.message } });
  },
  async enforceWorkspaceRole() {},
  async enforceSessionRead() {},
  getDb: () => db,
  notifyDbSubscribers(table, eventType, rows) {
   notifications.push({ table, eventType, rows });
  },
  runDueSchedules() {
   runnerCalls += 1;
  },
  roleHasWorkspaceCapability,
  sessionReadableSql,
 });
 const server = http.createServer(app);
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 try {
  await run({
   baseUrl: `http://127.0.0.1:${server.address().port}`,
   mutations,
   notifications,
   runnerCalls: () => runnerCalls,
  });
 } finally {
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
 }
}

test('every schedule write and history read fails closed when private access changes after preflight', async () => {
 await withScheduleServer({ lockedSessionRows: [] }, async ({
  baseUrl,
  mutations,
  notifications,
  runnerCalls,
 }) => {
  const requests = [
   fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: AGENT, sessionId: SESSION }),
   }),
   fetch(`${baseUrl}/backend/schedules/${SCHEDULE}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
   }),
   fetch(`${baseUrl}/backend/schedules/${SCHEDULE}`, { method: 'DELETE' }),
   fetch(`${baseUrl}/backend/schedules/${SCHEDULE}/run`, { method: 'POST' }),
   fetch(`${baseUrl}/backend/schedules/${SCHEDULE}/runs`),
  ];
  const responses = await Promise.all(requests);
  for (const response of responses) {
   assert.equal(response.status, 403, await response.clone().text());
   assert.match((await response.json()).error.message, /access changed/i);
  }
  assert.deepEqual(mutations, []);
  assert.deepEqual(notifications, []);
  assert.equal(runnerCalls(), 0);
 });
});

test('schedule creation rejects an agent that is not in the locked conversation roster', async () => {
 await withScheduleServer({
  lockedSessionRows: [{ ...sessionRow(), participants: [] }],
 }, async ({ baseUrl, mutations, notifications }) => {
  const response = await fetch(`${baseUrl}/backend/workspaces/${WORKSPACE}/schedules`, {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ agentId: AGENT, sessionId: SESSION }),
  });
  assert.equal(response.status, 409, await response.clone().text());
  assert.match((await response.json()).error.message, /no longer available/i);
  assert.deepEqual(mutations, []);
  assert.deepEqual(notifications, []);
 });
});

test.afterEach(() => __test.resetTestState());

test('the due worker cannot insert a message after the author loses private-session access', async () => {
 const calls = [];
 let messageInserted = false;
 const dueSchedule = scheduleRow();
 const db = {
  async unsafe(sql, params = []) {
   const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   calls.push({ sql: q, params });
   if (q.startsWith('with due_candidates as materialized')) return [dueSchedule];
   if (q.startsWith('with recursive schedule_workspace_chain')) {
    return [{ id: WORKSPACE, user_id: USER, role: null }];
   }
   if (q.startsWith('select schedule_session_scope.id')) return [];
   if (q.startsWith('insert into messages')) {
    messageInserted = true;
    return [{ id: 'message-should-not-exist' }];
   }
   if (q.startsWith('update agent_schedules set running = false')) {
    return [scheduleRow({
     running: false,
     enabled: false,
     last_status: 'error',
    })];
   }
   if (q.startsWith('insert into agent_schedule_runs')) {
    return [{
     id: '66666666-6666-4666-8666-666666666666',
     schedule_id: SCHEDULE,
     workspace_id: WORKSPACE,
     session_id: SESSION,
     status: params[3],
     detail: params[4],
    }];
   }
   return [];
  },
  async begin(callback) {
   return callback(db);
  },
 };
 __test.setTestDb(db);

 await __test.runDueSchedules();

 assert.equal(messageInserted, false);
 const finalUpdate = calls.find(call => (
  call.sql.startsWith('update agent_schedules set running = false')
  && call.params.length === 4
 ));
 assert.ok(finalUpdate);
 assert.equal(finalUpdate.params[1], 'error');
 assert.equal(finalUpdate.params[3], true, 'lost authority permanently disables the schedule');
});

test('the claim query skips locked sessions and invalid targets cannot consume the batch limit', async () => {
 const source = require('node:fs').readFileSync(
  require('node:path').resolve(__dirname, '../server/index.cjs'),
  'utf8',
 );
 const claim = source.match(/with due_candidates as materialized \([\s\S]*?returning \*/)?.[0] || '';
 assert.match(claim, /join chat_sessions candidate_session/);
 assert.ok(
  claim.indexOf('join chat_sessions candidate_session') < claim.indexOf('limit 10'),
  'live session filtering must happen before the batch limit',
 );
 assert.match(claim, /for share of live_session skip locked/i);
});

test('agent_schedules.session_id is non-null in bootstrap, canonical schema, and migration', () => {
 const fs = require('node:fs');
 const path = require('node:path');
 const runtime = fs.readFileSync(path.resolve(__dirname, '../server/index.cjs'), 'utf8');
 const canonical = fs.readFileSync(path.resolve(__dirname, '../database/neon-schema.sql'), 'utf8');
 const migration = fs.readFileSync(
  path.resolve(__dirname, '../supabase/migrations/20260731183000_agent_schedules_session_not_null.sql'),
  'utf8',
 );
 for (const source of [runtime, canonical]) {
  const table = source.match(/CREATE TABLE IF NOT EXISTS agent_schedules \([\s\S]*?\n\s*\);/)?.[0] || '';
  assert.match(table, /session_id uuid NOT NULL REFERENCES chat_sessions/);
 }
 assert.match(migration, /DELETE FROM agent_schedules WHERE session_id IS NULL/);
 assert.match(migration, /ALTER COLUMN session_id SET NOT NULL/);
});

test('one history failure releases its claim and does not strand the remaining claimed batch', async () => {
 const secondSchedule = '88888888-8888-4888-8888-888888888888';
 const due = [scheduleRow(), scheduleRow({ id: secondSchedule })];
 const historyAttempts = [];
 const recovered = [];
 const finalUpdates = [];
 const db = {
  async unsafe(sql, params = []) {
   const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   if (q.startsWith('update agent_schedules schedule set enabled = false')) return [];
   if (q.includes("last_status = 'recovered interrupted schedule run'")) return [];
   if (q.includes("last_status = 'schedule finalization failed'")) {
    recovered.push(params[0]);
    return [scheduleRow({ id: params[0], running: false })];
   }
   if (q.startsWith('update agent_schedules set running = false, last_status =')) {
    finalUpdates.push(params[0]);
    return [scheduleRow({ id: params[0], running: false })];
   }
   if (q.startsWith('with due_candidates as materialized')) return due;
   if (q.startsWith('with recursive schedule_workspace_chain')) {
    return [{ id: WORKSPACE, user_id: USER, role: null }];
   }
   if (q.startsWith('select schedule_session_scope.id')) return [sessionRow()];
   // Make launch fail safely before a message is written; finalization must
   // still process both claimed rows.
   if (q.startsWith('select * from workspace_agents schedule_agent_scope')) return [];
   if (q.startsWith('insert into agent_schedule_runs')) {
    historyAttempts.push(params[0]);
    if (params[0] === SCHEDULE) throw new Error('simulated history failure');
    return [{
     id: '99999999-9999-4999-8999-999999999999',
     schedule_id: params[0],
     workspace_id: WORKSPACE,
     session_id: SESSION,
     status: params[3],
     detail: params[4],
    }];
   }
   return [];
  },
  async begin(callback) {
   return callback(db);
  },
 };
 __test.setTestDb(db);

 await __test.runDueSchedules();

 assert.deepEqual(historyAttempts, [SCHEDULE, secondSchedule]);
 assert.deepEqual(recovered, [SCHEDULE]);
 assert.deepEqual(finalUpdates, [SCHEDULE, secondSchedule]);
});
