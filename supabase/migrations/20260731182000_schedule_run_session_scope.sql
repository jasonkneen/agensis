-- Run history inherits the target conversation's privacy. Persist the session
-- directly so generic reads and realtime fanout can apply the canonical
-- session-audience rule without an unscoped workspace-wide side channel.
ALTER TABLE agent_schedule_runs
  ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE;

UPDATE agent_schedule_runs run
   SET session_id = schedule.session_id
  FROM agent_schedules schedule
 WHERE schedule.id = run.schedule_id
   AND run.session_id IS NULL;

DELETE FROM agent_schedule_runs WHERE session_id IS NULL;
ALTER TABLE agent_schedule_runs ALTER COLUMN session_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_session
  ON agent_schedule_runs(session_id, created_at DESC);
