'use strict';

// Operator surface for the agent queues. Before this file there were drains, but
// no door a person could open: scheduleTaskQueueDrain, drainPendingChatTurn,
// and the cadence wake map were reachable only from inside the process, so a
// queue that wedged behind a missed fire or a lost cadence wake had to wait for
// the next reaper tick (30s) or — in the cadence case — a redeploy.
//
// The endpoints here:
//
//   POST /backend/workspaces/:id/agents/:agentId/queue/drain
//     Manage-gated. Forcibly runs the task-queue drain and / or the chat-turn
//     drain for one (workspace, agent) pair right now, bypassing the in-process
//     debounce. Idempotent — firing twice is the same as firing once. Each call
//     audits a `agent.queue_force_drained` row with kind, dispatched/found
//     counts, and the operator who pressed the button. The audit row is the
//     durable answer to "did anything actually happen".
//
//   GET /backend/workspaces/:id/agents/:agentId/queue/status
//     Read-gated. A snapshot of the three queues for one (workspace, agent):
//     count of assigned 'todo' tasks, count of parked chat turns, the active
//     job if any, and the last audit row for `agent.queue_force_drained` so the
//     operator can see whether anyone has already tried to nudge it.
//
// The MCP tool surface (`force_drain_agent_queue`, `get_agent_queue_status`)
// reaches the SAME logic via createAgentQueueService so a forced drain through
// MCP and through the HTTP route audit the same `agent.queue_force_drained`
// row and cannot drift.
//
// WHY MANAGE, NOT WRITE. A forced drain does NOT start work — the drain
// itself respects hasActiveBurstJob / agentHasAnyActiveJob — but what it
// UNBLOCKS will start work. That is the same class of action as assigning a
// task and costs the workspace a model call. The gate is the same as the
// task-assign route, not the same as the cancel-route (which only ends work
// the user already started).
//
// Dependencies are INJECTED (the pattern of server/reactions-routes.cjs and
// server/agent-job-cancel-routes.cjs) so the auth, RBAC and rate-limit contract
// stays single-sourced in index.cjs / shared/backend-core.cjs.

const DRAIN_KINDS = Object.freeze(new Set(['all', 'tasks', 'chat']));
const MAX_AGE_DAYS_FOR_STATUS = 90;

function normalizeKind(value) {
 const raw = String(value || 'all').trim().toLowerCase();
 return DRAIN_KINDS.has(raw) ? raw : null;
}

function publicDrainResult({ kind, dispatchedTask = false, dispatchedTaskId = null, foundParkedChat = 0, drainReason = null }) {
 return {
  kind,
  dispatchedTask,
  dispatchedTaskId,
  foundParkedChat,
  drainReason,
 };
}

/**
 * The non-transport logic. Both the HTTP route and the MCP tool wrap this so
 * they share the same audit row, the same drain behaviour and the same status
 * shape. Keep it transport-free: no `req`, no `res`, no `identity`.
 */
function createAgentQueueService({
 getDb,
 recordAudit,
 drainAgentTaskQueue,
 drainPendingChatTurn,
 enforceWorkspaceRole,
 onWarn = () => {},
}) {
 if (typeof getDb !== 'function') throw new Error('createAgentQueueService requires getDb');
 if (typeof recordAudit !== 'function') throw new Error('createAgentQueueService requires recordAudit');
 if (typeof drainAgentTaskQueue !== 'function') throw new Error('createAgentQueueService requires drainAgentTaskQueue');
 if (typeof drainPendingChatTurn !== 'function') throw new Error('createAgentQueueService requires drainPendingChatTurn');
 if (typeof enforceWorkspaceRole !== 'function') throw new Error('createAgentQueueService requires enforceWorkspaceRole');

 /**
  * Force a drain now. Throws ToolError-shaped errors with a `status` field so
  * callers can map them to HTTP codes or MCP isError flags.
  */
 async function forceDrain({ workspaceId, agentId, kind, actor }) {
  const wsId = String(workspaceId || '').trim();
  const aId = String(agentId || '').trim();
  if (!wsId) throw Object.assign(new Error('A workspace id is required'), { status: 400 });
  if (!aId) throw Object.assign(new Error('An agent id is required'), { status: 400 });
  const k = normalizeKind(kind);
  if (!k) throw Object.assign(new Error('kind must be one of: tasks, chat, all'), { status: 400 });

  // The actor.authorize runs the same gate as the HTTP route: 'manage'. The MCP
  // identity kinds that reach this tool ('workspace', 'user') are the same
  // surface that triggers manage in the HTTP world.
  await enforceWorkspaceRole(actor?.userId || null, wsId, 'manage');

  // Confirm the agent exists in the workspace BEFORE firing drains, so a
  // typo'd agentId costs one cheap query rather than three silent no-ops.
  const agentRows = await getDb().unsafe(
   `select id from workspace_agents where id = $1::uuid and workspace_id = $2::uuid limit 1`,
   [aId, wsId],
  );
  if (agentRows.length === 0) throw Object.assign(new Error('Agent not found in this workspace'), { status: 404 });

  // Tasks: call drainAgentTaskQueue directly (not its fire-and-forget wrapper
  // scheduleTaskQueueDrain) so the result is observable.
  let dispatchedTask = false;
  let dispatchedTaskId = null;
  let drainReason = null;
  if (k === 'tasks' || k === 'all') {
   const outcome = await drainAgentTaskQueue({ workspaceId: wsId, agentId: aId, cause: 'operator_force' })
    .catch((error) => {
     onWarn(`task-queue force-drain failed for ${wsId}/${aId}: ${error?.message || error}`);
     return null;
    });
   if (outcome && outcome.dispatched) {
    dispatchedTask = true;
    dispatchedTaskId = outcome.taskId || null;
   }
   drainReason = outcome?.reason || null;
  }

  // Chat turns: the only useful count is the snapshot of pending_chat_turns
  // rows FOR THIS AGENT before the call, which is the size of the backlog the
  // operator saw in the UI.
  let foundParkedChat = 0;
  if (k === 'chat' || k === 'all') {
   const parkedRows = await getDb().unsafe(
    `select park_key from pending_chat_turns
       where workspace_id = $1::uuid and agent_id = $2::uuid`,
    [wsId, aId],
   ).catch((error) => {
    onWarn(`could not read pending_chat_turns for ${wsId}/${aId}: ${error?.message || error}`);
    return [];
   });
   foundParkedChat = parkedRows.length;
   await drainPendingChatTurn(/* sessionId */ null, aId, 'operator_force')
    .catch((error) => {
     onWarn(`chat-turn force-drain failed for ${wsId}/${aId}: ${error?.message || error}`);
    });
  }

  const result = publicDrainResult({ kind: k, dispatchedTask, dispatchedTaskId, foundParkedChat, drainReason });

  // Audit MUST follow the action, not precede it — see the comment block on
  // server/agent-job-cancel-routes.cjs for the same rule. recordAudit is
  // fire-and-forget; an audit failure never breaks the caller.
  await recordAudit({
   workspaceId: wsId,
   action: 'agent.queue_force_drained',
   actor: { userId: actor?.userId || null },
   targetType: 'workspace_agent',
   targetId: aId,
   targetLabel: `queue.${k}`,
   detail: {
    kind: k,
    dispatchedTask,
    dispatchedTaskId,
    foundParkedChat,
    drainReason,
   },
  });

  return result;
 }

 /**
  * Read the queue snapshot. Read-gated; 'read' is the same gate the inbox and
  * other agent-list surfaces use, so an operator with manage is automatically
  * authorised. Returns a stable JSON shape.
  */
 async function getStatus({ workspaceId, agentId, actor }) {
  const wsId = String(workspaceId || '').trim();
  const aId = String(agentId || '').trim();
  if (!wsId) throw Object.assign(new Error('A workspace id is required'), { status: 400 });
  if (!aId) throw Object.assign(new Error('An agent id is required'), { status: 400 });

  await enforceWorkspaceRole(actor?.userId || null, wsId, 'read');

  const [taskRows, parkedRows, activeJobs, lastDrainRows] = await Promise.all([
   getDb().unsafe(
    `select count(*)::int as total,
            count(*) filter (where status = 'todo')::int as todo,
            count(*) filter (where status = 'in_progress')::int as in_progress
       from tasks
      where workspace_id = $1::uuid
        and assignee_id = $2::uuid
        and status in ('todo', 'in_progress')`,
    [wsId, aId],
   ),
   getDb().unsafe(
    `select count(*)::int as total,
            min(parked_at) as oldest_parked_at
       from pending_chat_turns
      where workspace_id = $1::uuid
        and agent_id = $2::uuid`,
    [wsId, aId],
   ),
   getDb().unsafe(
    `select id, status, started_at, finished_at
       from agent_jobs
      where workspace_id = $1::uuid
        and agent_id = $2::uuid
        and status in ('queued', 'running')
      order by started_at desc nulls last
      limit 1`,
    [wsId, aId],
   ),
   // Authoritative answer to "has anyone tried to nudge this agent, and when" —
   // the audit log is the durable history, so a process restart does not
   // forget a forced drain an operator just performed.
   getDb().unsafe(
    `select created_at, actor_user_id, detail
       from audit_log
      where workspace_id = $1::uuid
        and action = 'agent.queue_force_drained'
        and (detail->>'kind') is not null
        and created_at > now() - ($2 || ' days')::interval
      order by created_at desc
      limit 1`,
    [wsId, String(MAX_AGE_DAYS_FOR_STATUS)],
   ),
  ]);

  const taskRow = taskRows?.[0] || { total: 0, todo: 0, in_progress: 0 };
  const parkedRow = parkedRows?.[0] || { total: 0, oldest_parked_at: null };
  const activeJob = activeJobs?.[0] || null;
  const lastDrainRow = lastDrainRows?.[0] || null;

  const lastDrain = lastDrainRow ? {
   at: lastDrainRow.created_at,
   actorUserId: lastDrainRow.actor_user_id || null,
   kind: (lastDrainRow.detail && lastDrainRow.detail.kind) || null,
   dispatchedTask: Boolean(lastDrainRow.detail && lastDrainRow.detail.dispatchedTask),
   dispatchedTaskId: (lastDrainRow.detail && lastDrainRow.detail.dispatchedTaskId) || null,
   foundParkedChat: (lastDrainRow.detail && Number(lastDrainRow.detail.foundParkedChat)) || 0,
   drainReason: (lastDrainRow.detail && lastDrainRow.detail.drainReason) || null,
  } : null;

  return {
   workspaceId: wsId,
   agentId: aId,
   tasks: {
    total: Number(taskRow.total) || 0,
    todo: Number(taskRow.todo) || 0,
    inProgress: Number(taskRow.in_progress) || 0,
   },
   chat: {
    parked: Number(parkedRow.total) || 0,
    oldestParkedAt: parkedRow.oldest_parked_at || null,
   },
   activeJob: activeJob ? {
    id: String(activeJob.id),
    status: String(activeJob.status),
    startedAt: activeJob.started_at || null,
    finishedAt: activeJob.finished_at || null,
   } : null,
   lastDrain,
  };
 }

 return { forceDrain, getStatus };
}

function mountAgentQueueRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, badRequest, getDb, enforceWorkspaceRole,
  recordAudit, drainAgentTaskQueue, drainPendingChatTurn,
  rateLimitBlocked, agentQueueControlRateLimiter,
  onWarn = () => {},
 } = deps;

 const queueService = createAgentQueueService({
  getDb,
  recordAudit,
  drainAgentTaskQueue,
  drainPendingChatTurn,
  enforceWorkspaceRole,
  onWarn: (message) => onWarn(message),
 });

 app.post('/backend/workspaces/:id/agents/:agentId/queue/drain', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const agentId = String(req.params.agentId || '').trim();

   // A burst on one agent is the shape a jittery double-click makes; per-agent
   // rate limiting lets a single operator legitimately nudge several agents at
   // once (the moment the feature exists for) without unbounded retries on
   // the same one.
   if (rateLimitBlocked(res, agentQueueControlRateLimiter, `${req.userId}:${agentId}`)) return;

   const result = await queueService.forceDrain({
    workspaceId,
    agentId,
    kind: req.body?.kind,
    actor: { userId: req.userId || null },
   });
   return res.json({ data: result, error: null });
  } catch (error) {
   return jsonError(res, error?.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/agents/:agentId/queue/status', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const agentId = String(req.params.agentId || '').trim();
   const result = await queueService.getStatus({
    workspaceId,
    agentId,
    actor: { userId: req.userId || null },
   });
   return res.json({ data: result, error: null });
  } catch (error) {
   return jsonError(res, error?.status || 500, error);
  }
 });
}

module.exports = {
 mountAgentQueueRoutes,
 createAgentQueueService,
 DRAIN_KINDS,
 normalizeKind,
 publicDrainResult,
};