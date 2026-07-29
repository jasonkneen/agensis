-- taskThreadLastWordAt (server/task-dispatch.cjs) resolves "who spoke last in a
-- task's thread" by filtering `root.source_task_id = <task>.id`. The only index
-- covering that column is idx_messages_source_task_id ON messages(session_id,
-- source_task_id), and a predicate on the TRAILING column alone cannot use a
-- composite B-tree — Postgres has no index skip scan. The subquery is embedded
-- in taskWaitingSql, which evaluates it twice, and taskWaitingSql runs on every
-- queue drain and twice more in the queue-position query.
--
-- Partial on both predicates because the query always pairs source_task_id with
-- `thread_parent_id is null`, and only thread ROOTS carry source_task_id. On
-- production that is 23 of 5493 message rows, so the index is 16 kB.
--
-- Measured, transactionally, against production before shipping: the planner
-- does pick this index (twice per drain, as expected). The gain today is small
-- (~4%) because the dominant cost is the OTHER side of that join — `m`, joined
-- on the expression coalesce(m.thread_parent_id, m.id), which no index can
-- serve. This index is worth having anyway: it is tiny, it is used, and unlike
-- the expression join its benefit grows as tasks accumulate threads. Removing
-- the remaining sequential scans would need the join rewritten, which is a
-- correctness risk on the hottest queue path and deliberately not done here.
--
-- The composite index is deliberately KEPT: postTaskSubthreadMention
-- (server/index.cjs) queries on session_id AND source_task_id and does use it.
CREATE INDEX IF NOT EXISTS idx_messages_source_task_root
  ON messages(source_task_id)
  WHERE source_task_id IS NOT NULL AND thread_parent_id IS NULL;
