'use strict';

// Stop ONE running agent turn.
//
// WHY THIS ROUTE HAD TO EXIST. Everything underneath it was already built and
// already correct — the 'cancelled' terminal status, the compare-and-set, the
// `agent_job_cancel` websocket frame, the daemon's queue abort and SIGTERM of
// the subprocess group, the in-process AbortController in builtin-turn.cjs, and
// the guard that discards a result frame arriving after a cancel. There was
// simply no door a person could open. The only cancel endpoint was
// /backend/integrations/farm/jobs/:id/cancel, which needs a Farm token AND only
// matches jobs with metadata->>'mode' = 'farm', so the web UI could not reach
// it. The other way a job got cancelled was clearing or closing the whole
// conversation — which also soft-deletes every message in it. "Stop what you
// are doing" and "delete this conversation" should not be the same button.
//
// THE ORDER IS THE CONTRACT, and it is not stylistic:
//
//   1. Win the durable `status='cancelled'` compare-and-set.
//   2. Only then fire the runtime effects.
//
// builtin-turn.cjs:105-111 states it explicitly, and the reason is crash
// safety. Abort the in-process turn first and the process can die before the
// row is written, leaving a job that is 'running' forever with nothing running.
// Doing the row first means a crash between the two steps still leaves a
// correctly-cancelled row, and the running-only terminal updates downstream
// discard the resulting AbortError instead of overwriting the status.
//
// IT IS IDEMPOTENT. A job that is already terminal returns 200 with its current
// status rather than 404 or 409: the button is pressed exactly when the user is
// unsure whether anything is still happening, and double-clicking it must not
// produce an error. The CAS losing (0 rows) is the same case — re-read and
// report what actually holds.
//
// Dependencies are INJECTED (the pattern of server/reactions-routes.cjs) so the
// auth, RBAC and rate-limit contract stays single-sourced in index.cjs and
// shared/backend-core.cjs, and this file cannot drift from it.

const CANCELLABLE = ['queued', 'running'];

const CANCEL_SQL = `
  update agent_jobs
     set status = 'cancelled',
         error = $2,
         metadata = case
           when jsonb_typeof(metadata) = 'object'
             then metadata || '{"stopReason":"cancelled"}'::jsonb
           else '{"stopReason":"cancelled"}'::jsonb
         end,
         finished_at = now(),
         updated_at = now()
   where id = $1::uuid
     and status in ('queued', 'running')
  returning id, workspace_id, session_id, agent_id, connection_id, status, metadata,
            started_at, finished_at, created_at, updated_at`;

function publicJob(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    workspace_id: row.workspace_id ? String(row.workspace_id) : null,
    session_id: row.session_id ? String(row.session_id) : null,
    agent_id: row.agent_id ? String(row.agent_id) : null,
    status: String(row.status || ''),
    finished_at: row.finished_at || null,
  };
}

function mountAgentJobCancelRoutes(app, deps = {}) {
  const {
    requireAuth, jsonError, badRequest, getDb, notifyDbSubscribers,
    enforceWorkspaceRole, enforceSessionRead,
    cancelBuiltinJob, sendToConnection, scheduleTaskQueueDrain,
    rateLimitBlocked, agentJobCancelRateLimiter,
    onWarn = () => {},
  } = deps;

  app.post('/backend/agent-jobs/:jobId/cancel', requireAuth, async (req, res) => {
    try {
      const jobId = String(req.params.jobId || '').trim();
      if (!jobId) return jsonError(res, 400, badRequest('A job id is required'));

      // Per (user, job). A burst on one job is the shape a jittery double-click
      // makes; limiting the user globally would stop someone legitimately
      // halting several runaway agents at once, which is exactly the moment
      // this feature is for.
      if (rateLimitBlocked(res, agentJobCancelRateLimiter, `${req.userId}:${jobId}`)) return;

      // Resolve the job AND its session in one statement, then authorize
      // against what we read. Authorizing one row and mutating another is the
      // classic shape of this bug, so the id checked is the id updated.
      const rows = await getDb().unsafe(
        `select j.id, j.workspace_id, j.session_id, j.agent_id, j.connection_id, j.status,
                s.id as s_id, s.workspace_id as s_workspace_id, s.visibility, s.folder, s.deleted_at
           from agent_jobs j
           left join chat_sessions s on s.id = j.session_id
          where j.id = $1::uuid
          limit 1`,
        [jobId],
      );
      const job = rows[0];
      if (!job) return jsonError(res, 404, new Error('Job not found'));

      // Stopping an agent is a WRITE: it ends a turn other people can see and
      // writes a terminal row. A viewer may watch the channel and may not halt
      // the work in it.
      await enforceWorkspaceRole(req.userId, job.workspace_id, 'write');
      // …and the DM gate under it, so a workspace member who is not in a
      // private conversation cannot reach into it and stop the agent. Passing
      // the row already read means this costs no second query.
      if (job.session_id && job.s_id) {
        await enforceSessionRead(req.userId, String(job.session_id), {
          id: job.s_id,
          workspace_id: job.s_workspace_id,
          visibility: job.visibility,
          folder: job.folder,
          deleted_at: job.deleted_at,
        });
      }

      if (!CANCELLABLE.includes(String(job.status))) {
        // Already finished, errored or cancelled. Nothing to stop, and saying so
        // is not an error — see the idempotence note at the top.
        return res.json({ data: { job: publicJob(job), stopped: false } });
      }

      const reason = 'Stopped by a person';
      const updated = await getDb().unsafe(CANCEL_SQL, [jobId, reason]);
      if (updated.length === 0) {
        // The reaper, a session close or another click won the race. Report
        // what actually holds rather than claiming this call did it.
        const current = await getDb().unsafe(
          'select id, workspace_id, session_id, agent_id, status, finished_at from agent_jobs where id = $1::uuid limit 1',
          [jobId],
        );
        return res.json({ data: { job: publicJob(current[0] || job), stopped: false } });
      }

      const row = updated[0];
      // The row is durable now, so the runtime may be told. Realtime first: the
      // badge and the Stop button are driven by agent_jobs, and the user should
      // see the control disappear whether or not a daemon is still reachable.
      notifyDbSubscribers('agent_jobs', 'UPDATE', updated);

      // An in-process built-in turn. Returns false when this job is not one,
      // which is the normal case for a daemon-backed agent.
      try {
        cancelBuiltinJob(String(row.id), reason);
      } catch (error) {
        onWarn(`could not abort built-in job ${row.id}: ${error?.message || error}`);
      }

      // A daemon-backed turn. The frame aborts the queue entry, denies any
      // parked permission prompt and SIGTERMs the subprocess group.
      let signalled = false;
      if (row.connection_id) {
        try {
          signalled = Boolean(sendToConnection(String(row.connection_id), {
            type: 'agent_job_cancel',
            jobId: String(row.id),
            reason,
          }));
        } catch (error) {
          onWarn(`could not signal daemon for job ${row.id}: ${error?.message || error}`);
        }
      }

      // Cancelling frees the agent exactly like finishing does, so whatever is
      // queued behind this turn gets its slot.
      try {
        if (row.workspace_id && row.agent_id) {
          scheduleTaskQueueDrain(String(row.workspace_id), String(row.agent_id), 'job_cancelled');
        }
      } catch (error) {
        onWarn(`could not drain queue after cancelling job ${row.id}: ${error?.message || error}`);
      }

      // `signalled` is reported, never used to decide success. The database
      // row is authoritative: a daemon whose socket is down still has a
      // cancelled job, and the late-result guard discards whatever it sends
      // when it comes back.
      return res.json({ data: { job: publicJob(row), stopped: true, signalled } });
    } catch (error) {
      return jsonError(res, error?.status || 500, error);
    }
  });
}

module.exports = { mountAgentJobCancelRoutes, CANCEL_SQL, CANCELLABLE };
