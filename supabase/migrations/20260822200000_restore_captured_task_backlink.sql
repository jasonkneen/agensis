-- Restore the channel back-link on tasks captured from a conversation.
--
-- server/chat-task-capture.cjs writes source_id = the session the human asked
-- in. Dispatch then overwrote it with the agent's DM id, because 'chat' is in
-- TASK_SOURCE_LINK_OVERWRITABLE and a captured task is 'chat' too. Fixed going
-- forward by dispatchMayStampSourceLink (server/task-dispatch.cjs); this repairs
-- the rows written before that landed.
--
-- The correct value is recoverable exactly, with no guessing: the capture's
-- origin_job_id points at the agent_jobs row, and that job's session_id IS the
-- conversation the work was requested in. Rows where the two already agree are
-- untouched, so this is idempotent.

UPDATE tasks t
   SET source_id = j.session_id::text,
       source_type = 'chat',
       updated_at = now()
  FROM agent_jobs j
 WHERE t.origin_job_id = j.id
   AND j.session_id IS NOT NULL
   AND t.source_id IS DISTINCT FROM j.session_id::text;
