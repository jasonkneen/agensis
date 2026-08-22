-- tasks.origin_job_id — the job a task was auto-captured from.
--
-- Forward-migration half of the three-place rule (canonical:
-- database/neon-schema.sql, runtime bootstrap: server/index.cjs). Backs
-- server/chat-task-capture.cjs, which turns a chat message that an agent is
-- still working on a minute later into a real, in-progress, assigned task.
--
-- The UNIQUE INDEX is not an optimisation, it is the correctness guarantee. The
-- capture sweep runs every 30 seconds against jobs that stay running for
-- minutes, on every Fly machine independently, so it re-sees the same job many
-- times; the insert relies on ON CONFLICT against this index to make the repeat
-- a no-op. Without it, one long turn would mint a task per tick.
--
-- It is also the proof that the SERVER wrote the row: auto-completion updates
-- only tasks matched by origin_job_id, so a task a human typed can never be
-- closed by an agent turn finishing.
--
-- ON DELETE SET NULL rather than CASCADE: agent_jobs rows are operational and
-- prunable, while the task is the durable artifact and must outlive the job.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin_job_id uuid REFERENCES agent_jobs(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_origin_job
  ON tasks (origin_job_id)
  WHERE origin_job_id IS NOT NULL;
