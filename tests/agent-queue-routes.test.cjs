'use strict';

// POST /backend/workspaces/:id/agents/:aid/queue/drain
// GET  /backend/workspaces/:id/agents/:aid/queue/status
//
// The properties that matter here are about the operator surface for the agent
// queues (task FIFO + parked chat turns), which before this route was reachable
// only from inside the process:
//
//   1. the route is 'manage'-gated: a force-drain can unblock work that costs a
//      model call, so the gate matches the task-assign route, not the cancel
//      route (which only ENDS work the user already started);
//   2. the per-(user, agent) rate limiter fires BEFORE the role check, so a
//      burst on a typo'd agent id cannot smuggle past enforcement;
//   3. the agent must exist in the workspace BEFORE the drain runs, otherwise a
//      typo silently succeeds with zero dispatched;
//   4. the chat count is a snapshot of pending_chat_turns BEFORE the drain
//      fires, because drainPendingChatTurn is fire-and-forget — by the time it
//      returns, the row is already either replayed or re-parked;
//   5. the audit row MUST follow the drain — same ordering rule as the cancel
//      route: a successful force-drain with no audit row would be invisible;
//   6. failure of drainAgentTaskQueue or drainPendingChatTurn is .caught and
//      logged via onWarn so a transient drain failure returns a count and a
//      log line, never a 500;
//   7. the status route is read-gated and reports the audit row for the last
//      forced drain so the operator can see whether anyone has already tried.

const test = require('node:test');
const assert = require('node:assert/strict');

const { mountAgentQueueRoutes } = require('../server/agent-queue-routes.cjs');

function harness(overrides = {}) {
 const events = [];
 let drainHandler = null;
 let statusHandler = null;
 const app = {
  post(path, _auth, fn) {
   if (path === '/backend/workspaces/:id/agents/:agentId/queue/drain') drainHandler = fn;
  },
  get(path, _auth, fn) {
   if (path === '/backend/workspaces/:id/agents/:agentId/queue/status') statusHandler = fn;
  },
 };

 // The agent-existence probe. Default: the agent exists.
 const agentExists = overrides.agentExists !== false;
 // The chat-park snapshot. Default: one parked turn for the agent.
 const parkedKeys = overrides.parkedKeys === undefined ? ['ws-1:sess-1:agent-1'] : overrides.parkedKeys;
 // Drain outcomes.
 const taskOutcome = overrides.taskOutcome === undefined
  ? { dispatched: true, taskId: 'task-1', reason: 'dispatched' }
  : overrides.taskOutcome;
 const chatDrainResult = overrides.chatDrainThrows === true
  ? 'throws'
  : undefined;

 let auditRow = null;
 const auditCalls = [];
 const state = {
  taskRows: overrides.taskRows || [{ total: 3, todo: 2, in_progress: 1 }],
  parkedRows: [{ total: parkedKeys.length, oldest_parked_at: '2026-09-21T00:00:00Z' }],
  activeJobs: overrides.activeJobs || [],
  lastDrainRows: overrides.lastDrainRows || [],
 };

 const deps = {
  requireAuth: (req, res, next) => next(),
  jsonError: (res, status, error) => res.status(status).json({ error: error?.message }),
  badRequest: message => Object.assign(new Error(message), { status: 400 }),
  getDb: () => ({
   unsafe: async (sql, params) => {
    if (/select id from workspace_agents/.test(sql)) {
     events.push('agent-exists');
     return agentExists ? [{ id: params[0] }] : [];
    }
    if (/count\(\*\).*::int as total[\s\S]*?from tasks/.test(sql)) {
     events.push('tasks-count');
     return state.taskRows;
    }
    if (/from pending_chat_turns\s+where workspace_id/.test(sql) && /select count\(\*\)/.test(sql) && /count\(\*\)::int as total/.test(sql)) {
     // status snapshot
     events.push('chat-count-status');
     return state.parkedRows;
    }
    if (/from pending_chat_turns\s+where workspace_id/.test(sql)) {
     // pre-drain snapshot
     events.push('chat-snapshot');
     return parkedKeys.map((k) => ({ park_key: k }));
    }
    if (/from agent_jobs\s+where workspace_id[\s\S]*?status in \('queued', 'running'\)/.test(sql)) {
     events.push('active-job');
     return state.activeJobs;
    }
    if (/from audit_log\s+where workspace_id[\s\S]*?action = 'agent\.queue_force_drained'/.test(sql)) {
     events.push('last-drain');
     return state.lastDrainRows;
    }
    events.push(`unknown-sql:${sql.slice(0, 60)}`);
    return [];
   },
  }),
  recordAudit: async (args) => {
   events.push('audit');
   auditCalls.push(args);
   if (auditRow) auditRow(args);
   if (overrides.auditThrows) throw new Error('audit boom');
  },
  drainAgentTaskQueue: async (args) => {
   events.push(`drain-tasks:${args.cause}`);
   if (overrides.taskDrainThrows) throw new Error('task drain boom');
   return taskOutcome;
  },
  drainPendingChatTurn: async (sessionId, agentId, cause) => {
   events.push(`drain-chat:${cause}:${agentId}`);
   if (chatDrainResult === 'throws') throw new Error('chat drain boom');
   return undefined;
  },
  enforceWorkspaceRole: async (_userId, _workspaceId, mode) => {
   events.push(`role:${mode}`);
   if (overrides.denyRole === mode) throw Object.assign(new Error('Forbidden'), { status: 403 });
  },
  rateLimitBlocked: () => Boolean(overrides.rateLimited),
  agentQueueControlRateLimiter: {},
  onWarn: (m) => events.push(`warn:${m}`),
 };

 mountAgentQueueRoutes(app, deps);
 assert.ok(drainHandler, 'drain route was not mounted');
 assert.ok(statusHandler, 'status route was not mounted');

 async function drain({ workspaceId = 'ws-1', agentId = 'agent-1', body = {} } = {}) {
  const res = {
   statusCode: 200,
   body: null,
   status(code) { this.statusCode = code; return this; },
   json(payload) { this.body = payload; return this; },
  };
  await drainHandler({ params: { id: workspaceId, agentId }, userId: 'user-1', body }, res);
  return res;
 }

 async function status({ workspaceId = 'ws-1', agentId = 'agent-1' } = {}) {
  const res = {
   statusCode: 200,
   body: null,
   status(code) { this.statusCode = code; return this; },
   json(payload) { this.body = payload; return this; },
  };
  await statusHandler({ params: { id: workspaceId, agentId }, userId: 'user-1' }, res);
  return res;
 }

 return { drain, status, events, auditCalls };
}

test('the drain route calls both drains, audits, and reports counts', async () => {
 const { drain, events, auditCalls } = harness();
 const res = await drain({ body: { kind: 'all' } });
 assert.equal(res.statusCode, 200);
 assert.deepEqual(res.body, {
  data: {
   kind: 'all',
   dispatchedTask: true,
   dispatchedTaskId: 'task-1',
   foundParkedChat: 1,
   drainReason: 'dispatched',
  },
  error: null,
 });
 // The task drain must run BEFORE the chat snapshot (snapshot is what the
 // operator saw), and the audit row MUST come AFTER both drains.
 assert.ok(events.indexOf('role:manage') < events.indexOf('drain-tasks:operator_force'),
  'role check ran before the task drain');
 assert.ok(events.indexOf('drain-tasks:operator_force') < events.indexOf('chat-snapshot'),
  'chat snapshot ran after the task drain');
 assert.ok(events.indexOf('drain-chat:operator_force:agent-1') < events.indexOf('audit'),
  'chat drain ran before the audit row');
 assert.equal(auditCalls.length, 1);
 assert.equal(auditCalls[0].action, 'agent.queue_force_drained');
 assert.equal(auditCalls[0].detail.kind, 'all');
 assert.equal(auditCalls[0].detail.dispatchedTask, true);
 assert.equal(auditCalls[0].detail.dispatchedTaskId, 'task-1');
 assert.equal(auditCalls[0].detail.foundParkedChat, 1);
});

test('kind: tasks skips the chat drain and the chat snapshot', async () => {
 const { drain, events } = harness();
 const res = await drain({ body: { kind: 'tasks' } });
 assert.equal(res.statusCode, 200);
 assert.equal(res.body.data.kind, 'tasks');
 assert.equal(res.body.data.foundParkedChat, 0);
 assert.ok(events.includes('drain-tasks:operator_force'));
 assert.ok(!events.some((e) => e.startsWith('drain-chat:')), 'chat drain should not fire');
 assert.ok(!events.includes('chat-snapshot'), 'chat snapshot should not fire');
});

test('kind: chat skips the task drain', async () => {
 const { drain, events } = harness();
 const res = await drain({ body: { kind: 'chat' } });
 assert.equal(res.statusCode, 200);
 assert.equal(res.body.data.kind, 'chat');
 assert.equal(res.body.data.dispatchedTask, false);
 assert.equal(res.body.data.foundParkedChat, 1);
 assert.ok(events.includes('drain-chat:operator_force:agent-1'));
 assert.ok(!events.some((e) => e.startsWith('drain-tasks:')), 'task drain should not fire');
});

test('invalid kind returns 400', async () => {
 const { drain, events } = harness();
 const res = await drain({ body: { kind: 'garbage' } });
 assert.equal(res.statusCode, 400);
 assert.ok(!events.includes('drain-tasks:operator_force'), 'no drain should fire on bad kind');
 assert.ok(!events.includes('audit'), 'no audit should fire on bad kind');
});

test('the rate limiter fires before the role check', async () => {
 const { drain, events } = harness({ rateLimited: true });
 const res = await drain();
 // The harness returns undefined for res.statusCode because rateLimitBlocked
 // does not write status; that's the contract — short-circuit without effect.
 assert.ok(!events.includes('role:manage'), 'role check should NOT have run when rate limited');
 assert.ok(!events.some((e) => e.startsWith('drain-')), 'no drain should have run');
});

test('a missing agent is a 404 BEFORE any drain fires', async () => {
 const { drain, events } = harness({ agentExists: false });
 const res = await drain();
 assert.equal(res.statusCode, 404);
 assert.ok(events.includes('agent-exists'));
 assert.ok(!events.some((e) => e.startsWith('drain-')), 'no drain should fire on missing agent');
});

test('a drain throw is caught and does not 500 the route', async () => {
 const { drain, events, auditCalls } = harness({ taskDrainThrows: true });
 const res = await drain({ body: { kind: 'all' } });
 assert.equal(res.statusCode, 200);
 assert.equal(res.body.data.dispatchedTask, false);
 assert.ok(events.some((e) => e.startsWith('warn:')), 'onWarn should have fired');
 // The audit row STILL fires — it carries the warn-outcome so an operator can
 // later see "I pressed the button and nothing moved".
 assert.equal(auditCalls.length, 1);
 assert.equal(auditCalls[0].detail.dispatchedTask, false);
});

test('the status route reads three queues and the last audit row', async () => {
 const lastDrainRows = [{
  created_at: '2026-09-21T01:02:03Z',
  actor_user_id: 'user-42',
  detail: { kind: 'tasks', dispatchedTask: true, dispatchedTaskId: 'task-99', foundParkedChat: 0, drainReason: 'dispatched' },
 }];
 const activeJobs = [{ id: 'job-9', status: 'running', started_at: '2026-09-21T01:00:00Z', finished_at: null }];
 const { status, events } = harness({ lastDrainRows, activeJobs });
 const res = await status();
 assert.equal(res.statusCode, 200);
 assert.equal(res.body.data.tasks.todo, 2);
 assert.equal(res.body.data.tasks.inProgress, 1);
 assert.equal(res.body.data.chat.parked, 1);
 assert.equal(res.body.data.activeJob.id, 'job-9');
 assert.equal(res.body.data.activeJob.status, 'running');
 assert.equal(res.body.data.lastDrain.kind, 'tasks');
 assert.equal(res.body.data.lastDrain.actorUserId, 'user-42');
 assert.equal(res.body.data.lastDrain.dispatchedTaskId, 'task-99');
 assert.ok(events.includes('role:read'));
});

test('the status route returns null lastDrain when nothing forced', async () => {
 const { status } = harness({ lastDrainRows: [] });
 const res = await status();
 assert.equal(res.statusCode, 200);
 assert.equal(res.body.data.lastDrain, null);
 assert.equal(res.body.data.activeJob, null);
});

test('the status route is read-gated, not manage-gated', async () => {
 const { status, events } = harness();
 await status();
 assert.ok(events.includes('role:read'));
 assert.ok(!events.includes('role:manage'));
});

test('a missing workspace id is 400 on the drain route', async () => {
 const { drain } = harness();
 const res = await drain({ workspaceId: '' });
 assert.equal(res.statusCode, 400);
});