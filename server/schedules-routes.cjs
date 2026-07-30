'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Scheduled agent runs: the workspace's cron-like entries, their run history,
// and the manual "run now" trigger.
//
// The runner itself is not here. runDueSchedules is injected and fires from the
// 30-second reaper interval in index.cjs's startBackendServer — these routes only
// read and write the rows it acts on, plus the one path that asks it to run an
// entry immediately.
//
// Fly only: the Netlify mirror has no schedules routes, because it has no
// long-running process to fire them.

function mountSchedulesRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, notifyDbSubscribers,
  runDueSchedules,
 } = deps;

 app.get('/backend/workspaces/:id/schedules', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    `select * from agent_schedules where workspace_id = $1 order by created_at desc`,
    [workspaceId],
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Threads the signed-in user is involved in (authored at least one message in),
 // across the whole workspace — quick-access list. A "thread" here is a sub-thread
 // session (parent_message_id set) or any session the user has posted a threaded
 // reply in. Scoped by the user's own sends (sender_kind='user', sender_id=me).
 app.get('/backend/workspaces/:id/my-threads', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const limit = Math.min(100, Math.max(1, Math.trunc(Number(req.query.limit)) || 50));
   const rows = await getDb().unsafe(
    `select s.id, s.workspace_id, s.title, s.folder, s.participants, s.parent_message_id,
            s.updated_at, s.created_at,
            (select count(*) from messages m2 where m2.session_id = s.id and m2.deleted_at is null) as message_count,
            greatest(s.updated_at, coalesce((select max(m3.created_at) from messages m3 where m3.session_id = s.id), s.updated_at)) as last_activity
       from chat_sessions s
      where s.workspace_id = $1
        and s.deleted_at is null
        -- "Threads involving the user": a dedicated sub-thread session
        -- (parent_message_id set) the user has posted in. Restricted to sub-thread
        -- sessions because the UI opens each row via the sub-thread panel, which
        -- loads a whole session by id — an inline thread_parent_id reply lives in
        -- a normal channel session and needs a different opener, so it's excluded.
        and s.parent_message_id is not null
        and exists (
          select 1 from messages m
           where m.session_id = s.id and m.deleted_at is null
             and m.sender_kind = 'user' and m.sender_id = $2
        )
      order by last_activity desc nulls last
      limit $3`,
    [workspaceId, String(req.userId), limit],
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/schedules/:id/runs', requireAuth, async (req, res) => {
  try {
   const scheduleId = String(req.params.id || '').trim();
   const scheduleRows = await getDb().unsafe('select workspace_id from agent_schedules where id = $1 limit 1', [scheduleId]);
   if (!scheduleRows[0]) return res.json({ data: [], error: null });
   await enforceWorkspaceRole(req.userId, scheduleRows[0].workspace_id, 'read');
   const rows = await getDb().unsafe(
    `select * from agent_schedule_runs where schedule_id = $1 order by created_at desc limit 50`,
    [scheduleId],
   );
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/schedules', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'run_agents');
   const { agentId, sessionId, name, prompt, intervalSeconds, enabled } = req.body || {};
   if (!agentId || !sessionId) return jsonError(res, 400, new Error('agentId and sessionId are required'));
   const agentOk = await getDb().unsafe('select 1 from workspace_agents where id = $1 and workspace_id = $2 limit 1', [agentId, workspaceId]);
   if (!agentOk[0]) return jsonError(res, 404, new Error('Agent not found in this workspace'));
   const sessionOk = await getDb().unsafe('select 1 from chat_sessions where id = $1 and workspace_id = $2 limit 1', [sessionId, workspaceId]);
   if (!sessionOk[0]) return jsonError(res, 404, new Error('Session not found in this workspace'));
   const interval = Math.min(2592000, Math.max(60, Number(intervalSeconds) || 86400));
   const rows = await getDb().unsafe(
    `insert into agent_schedules
           (workspace_id, agent_id, session_id, created_by, name, prompt, interval_seconds, enabled, next_run_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, now() + ($9 || ' seconds')::interval)
         returning *`,
    [workspaceId, agentId, sessionId, req.userId, String(name || '').slice(0, 200), String(prompt || '').slice(0, 4000), interval, enabled !== false, String(interval)],
   );
   notifyDbSubscribers('agent_schedules', 'INSERT', rows);
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/schedules/:id', requireAuth, async (req, res) => {
  try {
   const scheduleId = String(req.params.id || '').trim();
   const scheduleRows = await getDb().unsafe('select * from agent_schedules where id = $1 limit 1', [scheduleId]);
   const schedule = scheduleRows[0];
   if (!schedule) return jsonError(res, 404, new Error('Schedule not found'));
   await enforceWorkspaceRole(req.userId, schedule.workspace_id, 'run_agents');
   const { name, prompt, intervalSeconds, enabled } = req.body || {};
   const nextName = name === undefined ? schedule.name : String(name).slice(0, 200);
   const nextPrompt = prompt === undefined ? schedule.prompt : String(prompt).slice(0, 4000);
   const nextInterval = intervalSeconds === undefined ? schedule.interval_seconds : Math.min(2592000, Math.max(60, Number(intervalSeconds) || schedule.interval_seconds));
   const nextEnabled = enabled === undefined ? schedule.enabled : Boolean(enabled);
   const rows = await getDb().unsafe(
    `update agent_schedules
            set name = $2, prompt = $3, interval_seconds = $4, enabled = $5, updated_at = now(),
                next_run_at = case when $5 = true and $6 = false then now() + ($7 || ' seconds')::interval else next_run_at end
          where id = $1 returning *`,
    [scheduleId, nextName, nextPrompt, nextInterval, nextEnabled, schedule.enabled, String(nextInterval)],
   );
   notifyDbSubscribers('agent_schedules', 'UPDATE', rows);
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/schedules/:id', requireAuth, async (req, res) => {
  try {
   const scheduleId = String(req.params.id || '').trim();
   const scheduleRows = await getDb().unsafe('select workspace_id from agent_schedules where id = $1 limit 1', [scheduleId]);
   if (!scheduleRows[0]) return res.json({ data: { id: scheduleId }, error: null });
   await enforceWorkspaceRole(req.userId, scheduleRows[0].workspace_id, 'run_agents');
   const rows = await getDb().unsafe('delete from agent_schedules where id = $1 returning *', [scheduleId]);
   notifyDbSubscribers('agent_schedules', 'DELETE', rows);
   res.json({ data: { id: scheduleId }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/schedules/:id/run', requireAuth, async (req, res) => {
  try {
   const scheduleId = String(req.params.id || '').trim();
   const scheduleRows = await getDb().unsafe('select * from agent_schedules where id = $1 limit 1', [scheduleId]);
   const schedule = scheduleRows[0];
   if (!schedule) return jsonError(res, 404, new Error('Schedule not found'));
   await enforceWorkspaceRole(req.userId, schedule.workspace_id, 'run_agents');
   const rows = await getDb().unsafe(
    `update agent_schedules set next_run_at = now(), enabled = true, updated_at = now() where id = $1 returning *`,
    [scheduleId],
   );
   notifyDbSubscribers('agent_schedules', 'UPDATE', rows);
   // Kick the runner now so the user gets immediate feedback instead of waiting
   // out the 30s tick. The runner's atomic claim keeps this safe against overlap.
   void runDueSchedules();
   res.json({ data: rows[0], error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountSchedulesRoutes };
