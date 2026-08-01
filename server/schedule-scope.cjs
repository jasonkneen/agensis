'use strict';

function scheduleScopeChanged(message = 'Schedule access changed before the operation completed') {
 const error = new Error(message);
 error.status = 403;
 error.code = 'SCHEDULE_SCOPE_CHANGED';
 return error;
}

function scheduleTargetUnavailable(message = 'The scheduled agent is no longer available in this conversation') {
 const error = new Error(message);
 error.status = 409;
 error.code = 'SCHEDULE_TARGET_UNAVAILABLE';
 return error;
}

function parseParticipants(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

/**
 * A schedule can only wake the agent it names. In a DM that agent must also be
 * the canonical direct target; merely being another roster entry is not enough.
 */
function scheduleAgentMatchesSession(session, agentId) {
 const wanted = String(agentId || '');
 if (!wanted) return false;
 const agents = parseParticipants(session?.participants)
  .filter(participant => (
   participant
   && participant.kind === 'agent'
   && participant.agent_id
  ));
 const selected = agents.find(participant => String(participant.agent_id) === wanted);
 if (!selected) return false;
 const direct = agents.find(participant => participant.direct)
  || (agents.length === 1 ? agents[0] : null);
 const isDirectMessage = String(session?.folder || '') === 'Direct messages'
  || agents.some(participant => participant.direct);
 return !isDirectMessage || String(direct?.agent_id || '') === wanted;
}

/**
 * Lock the complete workspace role proof used by a schedule operation.
 *
 * Ownership and inherited membership both live outside the schedule row. A
 * preflight role check is stale as soon as it returns, so every operation that
 * can expose history, mutate a schedule, or launch work repeats the proof under
 * locks in the same transaction as the protected statement.
 */
async function lockScheduleWorkspaceCapability({
 tx,
 userId,
 workspaceId,
 capability,
 roleHasWorkspaceCapability,
}) {
 const rows = await tx.unsafe(
  `with recursive schedule_workspace_chain as (
     select id, parent_id, 0 as depth
       from workspaces
      where id = $1
     union all
     select parent.id, parent.parent_id, chain.depth + 1
       from workspaces parent
       join schedule_workspace_chain chain on parent.id = chain.parent_id
      where chain.depth < 10
   ),
   schedule_locked_workspaces as materialized (
     select workspace.id, workspace.user_id
       from workspaces workspace
       join schedule_workspace_chain chain on chain.id = workspace.id
      for share of workspace
   ),
   schedule_locked_memberships as materialized (
     select membership.workspace_id, membership.role
       from workspace_members membership
       join schedule_locked_workspaces workspace
         on workspace.id = membership.workspace_id
      where membership.user_id = $2
      for share of membership
   )
   select workspace.id, workspace.user_id, membership.role
     from schedule_locked_workspaces workspace
     left join schedule_locked_memberships membership
       on membership.workspace_id = workspace.id`,
  [String(workspaceId), String(userId)],
 );
 const roles = new Set();
 for (const row of rows) {
  if (String(row.user_id || '') === String(userId)) roles.add('owner');
  if (row.role) roles.add(String(row.role));
 }
 if (![...roles].some(role => roleHasWorkspaceCapability(role, capability))) {
  throw scheduleScopeChanged('Workspace access changed before the schedule operation completed');
 }
 return rows;
}

/**
 * Lock the exact live conversation and, for a private session, the current
 * membership row selected by the canonical session predicate.
 *
 * FOR SHARE is intentional: schedule operations do not edit the session, but a
 * concurrent close needs FOR UPDATE and must wait until the schedule statement
 * commits. Message inserts may continue because their FK key-share lock is
 * compatible.
 */
async function lockScheduleSession({
 tx,
 userId,
 workspaceId,
 sessionId,
 sessionReadableSql,
}) {
 const rows = await tx.unsafe(
  `select schedule_session_scope.id,
          schedule_session_scope.workspace_id,
          schedule_session_scope.visibility,
          schedule_session_scope.folder,
          schedule_session_scope.participants,
          schedule_session_scope.deleted_at
     from chat_sessions schedule_session_scope
    where schedule_session_scope.id = $1
      and schedule_session_scope.workspace_id = $2
      and ${sessionReadableSql('schedule_session_scope', '$3', { lockMembership: true })}
    for share of schedule_session_scope`,
  [String(sessionId), String(workspaceId), String(userId)],
 );
 if (rows.length !== 1) {
  throw scheduleScopeChanged('Conversation access changed before the schedule operation completed');
 }
 return rows[0];
}

async function lockScheduleAgent({
 tx,
 agentId,
 workspaceId,
}) {
 const rows = await tx.unsafe(
  `select *
     from workspace_agents schedule_agent_scope
    where schedule_agent_scope.id = $1
      and schedule_agent_scope.workspace_id = $2
      and schedule_agent_scope.enabled is true
    for share of schedule_agent_scope`,
  [String(agentId), String(workspaceId)],
 );
 if (rows.length !== 1) throw scheduleTargetUnavailable();
 return rows[0];
}

async function lockScheduleRow({
 tx,
 scheduleId,
 workspaceId,
 sessionId,
 forUpdate = true,
}) {
 const rows = await tx.unsafe(
  `select *
     from agent_schedules schedule_scope
    where schedule_scope.id = $1
      and schedule_scope.workspace_id = $2
      and schedule_scope.session_id = $3
    ${forUpdate ? 'for update of schedule_scope' : 'for share of schedule_scope'}`,
  [String(scheduleId), String(workspaceId), String(sessionId)],
 );
 if (rows.length !== 1) {
  throw scheduleScopeChanged('Schedule changed before the operation completed');
 }
 return rows[0];
}

/**
 * Global lock order for a schedule attached to a conversation:
 *
 *   workspace lineage -> role rows -> session/member -> schedule
 *
 * Session closure follows the same order before it disables schedules, so a
 * close and a schedule operation serialize instead of deadlocking or acting on
 * a stale preflight.
 */
async function lockScheduleScope({
 tx,
 userId,
 workspaceId,
 sessionId,
 scheduleId,
 capability,
 roleHasWorkspaceCapability,
 sessionReadableSql,
 forUpdate = true,
}) {
 await lockScheduleWorkspaceCapability({
  tx,
  userId,
  workspaceId,
  capability,
  roleHasWorkspaceCapability,
 });
 const session = await lockScheduleSession({
  tx,
  userId,
  workspaceId,
  sessionId,
  sessionReadableSql,
 });
 const schedule = await lockScheduleRow({
  tx,
  scheduleId,
  workspaceId,
  sessionId,
  forUpdate,
 });
 return { session, schedule };
}

/**
 * Execution adds the agent row to the global order. Agent deletion locks the
 * agent before ON DELETE SET NULL touches schedules, so execution must do the
 * same: workspace -> session/member -> agent -> schedule.
 */
async function lockScheduleExecutionScope({
 tx,
 userId,
 workspaceId,
 sessionId,
 scheduleId,
 agentId,
 capability,
 roleHasWorkspaceCapability,
 sessionReadableSql,
}) {
 await lockScheduleWorkspaceCapability({
  tx,
  userId,
  workspaceId,
  capability,
  roleHasWorkspaceCapability,
 });
 const session = await lockScheduleSession({
  tx,
  userId,
  workspaceId,
  sessionId,
  sessionReadableSql,
 });
 if (!scheduleAgentMatchesSession(session, agentId)) {
  throw scheduleTargetUnavailable();
 }
 const agent = await lockScheduleAgent({ tx, agentId, workspaceId });
 const schedule = await lockScheduleRow({
  tx,
  scheduleId,
  workspaceId,
  sessionId,
  forUpdate: true,
 });
 if (String(schedule.agent_id || '') !== String(agent.id)) {
  throw scheduleTargetUnavailable('The scheduled agent changed before the run could start');
 }
 return { session, agent, schedule };
}

module.exports = {
 lockScheduleAgent,
 lockScheduleExecutionScope,
 lockScheduleRow,
 lockScheduleScope,
 lockScheduleSession,
 lockScheduleWorkspaceCapability,
 scheduleAgentMatchesSession,
 scheduleScopeChanged,
 scheduleTargetUnavailable,
};
