'use strict';

const {
 scrubMessageActivityBySessions,
 toPgArrayLiteral,
} = require('./backend-core.cjs');

const HUDDLE_RETURNING = 'id, workspace_id, session_id, room_name, started_by, started_at, ended_at, transcript_session_id, notes';
const SESSION_RETURNING = [
 'id', 'workspace_id', 'title', 'model', 'folder', 'description', 'icon', 'intent',
 'is_favorite', 'participants', 'conversation_mode', 'max_agent_turns', 'auto_rounds',
 'parent_message_id', 'split_parent_id', 'split_at', 'split_baseline_message_id',
 'split_source_boundary_message_id', 'archived_at', 'deleted_at',
 'canvas_id', 'version', 'visibility', 'created_at', 'updated_at',
].join(', ');
const PERMISSION_RETURNING = [
 'id', 'workspace_id', 'agent_id', 'job_id', 'connection_id', 'session_id', 'message_id',
 'request_key', 'tool_name', 'tool_detail', 'title', 'description', 'rules', 'scopes',
 'status', 'scope', 'decided_by', 'decided_by_name', 'decided_at', 'expires_at',
 'created_at', 'updated_at',
].join(', ');
const SCHEDULE_RETURNING = [
 'id', 'workspace_id', 'agent_id', 'session_id', 'created_by', 'name', 'prompt',
 'interval_seconds', 'enabled', 'running', 'next_run_at', 'last_run_at',
 'last_status', 'run_count', 'fail_count', 'created_at', 'updated_at',
].join(', ');
const MAX_DERIVATION_DEPTH = 64;

function uniqueIds(values) {
 return [...new Set((Array.isArray(values) ? values : [])
  .map(value => String(value || '').trim())
  .filter(Boolean))];
}

/**
 * Settle every durable child of an already-locked conversation.
 *
 * Callers MUST lock each host chat_sessions row FOR UPDATE before entering.
 * This function then follows the sole global order used by huddle mutations:
 *
 *   session -> its linked huddles -> its derived sessions -> jobs/messages
 *
 * "Derived" is transitive and includes sub-threads (parent_message_id), forks
 * (split_parent_id), and every huddle transcript, including already-ended
 * huddles. A private conversation is one deletion boundary: leaving an active
 * descendant behind would let its agent continue working on deleted context.
 *
 * Runtime effects deliberately do not happen here. The returned rows are the
 * exact compare-and-set winners a caller may broadcast/cancel only after the
 * surrounding transaction commits.
 */
async function settleSessionClosure({
 query,
 hostSessionIds,
 closeHostSessions = true,
} = {}) {
 if (typeof query !== 'function') throw new TypeError('settleSessionClosure requires query');
 const hostIds = uniqueIds(hostSessionIds);
 if (hostIds.length === 0) {
  return {
   allSessionIds: [],
   sessions: [],
   jobs: [],
   schedules: [],
   permissionRequests: [],
   huddles: [],
   clearedMessages: 0,
   clearedPresence: 0,
  };
 }

 const visitedSessionIds = new Set(hostIds);
 const huddlesById = new Map();
 let frontier = hostIds;
 let depth = 0;

 while (frontier.length > 0) {
  if (depth >= MAX_DERIVATION_DEPTH) {
   throw new Error(`Conversation derivation exceeds ${MAX_DERIVATION_DEPTH} levels`);
  }
  depth += 1;

  // Lock huddles before the transcript sessions they own. Huddle start/end
  // takes the same host-session -> huddle order, so concurrent closure cannot
  // form a lock cycle.
  const frontierHuddles = await query(
   `select ${HUDDLE_RETURNING.split(', ').map(column => `huddle.${column}`).join(', ')}
      from huddles huddle
      join chat_sessions host_session
        on host_session.id = huddle.session_id
       and host_session.workspace_id = huddle.workspace_id
     where huddle.session_id = any($1::uuid[])
     order by huddle.id
     for update of huddle`,
   [toPgArrayLiteral(frontier)],
  );
  for (const huddle of frontierHuddles) {
   if (huddle?.id) huddlesById.set(String(huddle.id), huddle);
  }

  const derived = await query(
   `select child_session.id
      from chat_sessions child_session
     where not (child_session.id = any($2::uuid[]))
       and exists (
         select 1
           from chat_sessions parent_session
          where parent_session.id = any($1::uuid[])
            and parent_session.workspace_id = child_session.workspace_id
            and (
              child_session.split_parent_id = parent_session.id
              or exists (
                select 1
                  from messages parent_message
                 where parent_message.id = child_session.parent_message_id
                   and parent_message.session_id = parent_session.id
              )
              or exists (
                select 1
                  from huddles parent_huddle
                 where parent_huddle.session_id = parent_session.id
                   and parent_huddle.workspace_id = parent_session.workspace_id
                   and parent_huddle.transcript_session_id = child_session.id
              )
            )
       )
     order by child_session.id
     for update of child_session`,
   [toPgArrayLiteral(frontier), toPgArrayLiteral([...visitedSessionIds])],
  );
  const next = uniqueIds(derived.map(row => row.id))
   .filter(id => !visitedSessionIds.has(id));
  for (const id of next) visitedSessionIds.add(id);
  frontier = next;
 }

 const allSessionIds = [...visitedSessionIds];
 const huddleRows = [...huddlesById.values()];
 const sessionArray = toPgArrayLiteral(allSessionIds);

 const schedules = await query(
  `update agent_schedules
      set enabled = false,
          running = false,
          last_status = 'Conversation deleted',
          updated_at = now()
    where session_id = any($1::uuid[])
      and (enabled is true or running is true)
  returning ${SCHEDULE_RETURNING}`,
  [sessionArray],
 );

 const jobs = await query(
  `update agent_jobs
      set status = 'cancelled',
          error = 'Conversation deleted',
          metadata = case
            when jsonb_typeof(metadata) = 'object'
              then metadata || '{"stopReason":"cancelled"}'::jsonb
            else '{"stopReason":"cancelled"}'::jsonb
          end,
          finished_at = now(),
          updated_at = now()
    where session_id = any($1::uuid[])
      and status in ('queued', 'running')
  returning id, workspace_id, session_id, agent_id, connection_id, status, metadata`,
  [sessionArray],
 );
 const jobIds = uniqueIds(jobs.map(row => row.id));

 const permissionRequests = await query(
  `update agent_permission_requests
      set status = 'expired',
          scope = '',
          decided_by = null,
          decided_by_name = 'Conversation deleted',
          decided_at = now(),
          updated_at = now()
    where status in ('pending', 'allowing', 'denying')
      and (
        session_id = any($1::uuid[])
        or job_id = any($2::uuid[])
      )
  returning ${PERMISSION_RETURNING}`,
  [sessionArray, toPgArrayLiteral(jobIds)],
 );

 const cleared = await query(
  `with cleared_messages as (
     update messages
        set deleted_at = coalesce(deleted_at, now())
      where session_id = any($1::uuid[])
        and deleted_at is null
    returning 1
   )
   select count(*)::integer as cleared_messages
     from cleared_messages`,
  [sessionArray],
 );

 // When the caller owns the host UPDATE, it still delegates every descendant
 // closure here. Otherwise a generic host close would strand subthreads/forks.
 const hostIdSet = new Set(hostIds);
 const sessionsToClose = closeHostSessions
  ? allSessionIds
  : allSessionIds.filter(id => !hostIdSet.has(id));
 const sessions = sessionsToClose.length > 0
  ? await query(
   `update chat_sessions
       set deleted_at = coalesce(deleted_at, now()),
           updated_at = now()
     where id = any($1::uuid[])
       and deleted_at is null
   returning ${SESSION_RETURNING}`,
   [toPgArrayLiteral(sessionsToClose)],
  )
  : [];

 const huddleIds = uniqueIds(huddleRows.map(row => row.id));
 const huddles = huddleIds.length > 0
  ? await query(
   `update huddles
       set ended_at = now()
     where id = any($1::uuid[])
       and ended_at is null
   returning ${HUDDLE_RETURNING}`,
   [toPgArrayLiteral(huddleIds)],
  )
  : [];
 const presence = huddleIds.length > 0
  ? await query(
   `with cleared_presence as (
     delete from huddle_presence
      where huddle_id = any($1::uuid[])
    returning 1
   )
   select count(*)::integer as cleared_presence
     from cleared_presence`,
   [toPgArrayLiteral(huddleIds)],
  )
  : [];

 await scrubMessageActivityBySessions({
  db: query,
  sessionIds: allSessionIds,
 });

 return {
  allSessionIds,
  sessions,
  jobs,
  schedules,
  permissionRequests,
  huddles,
  clearedMessages: Number(cleared[0]?.cleared_messages || 0),
  clearedPresence: Number(presence[0]?.cleared_presence || 0),
 };
}

module.exports = {
 HUDDLE_RETURNING,
 MAX_DERIVATION_DEPTH,
 PERMISSION_RETURNING,
 SCHEDULE_RETURNING,
 SESSION_RETURNING,
 settleSessionClosure,
 uniqueIds,
};
