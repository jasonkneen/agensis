-- Durable cadence wakes. SM-5 from docs/queue-plumbing-audit-2026-09-21.md.
--
-- Why now: cadenceWakes was an in-process Map keyed by lockKey, with a
-- setTimeout for the fire. Two ways to lose a wake, both real in production:
--
--   1. A multi-replica deploy routes the social-channel continue that
--      triggers `scheduleCadenceWake` to replica A, but the human message
--      that should have re-prompted the agent lands on replica B — B never
--      sees the wake, so the agent silently stops answering until the user
--      @-mentions again.
--   2. A wake is scheduled, then the replica restarts (deploy, crash,
--      graceful shutdown for a Fly update). The in-process Map is gone; the
--      wake is gone with it.
--
-- The previous design rejected a durable `next_reply_at` column with the
-- reason "one missed clear is a channel that re-answers an old message on a
-- timer". That concern is preserved here in three places:
--
--   * The reaper reads ONLY rows whose `next_fire_at <= now()` — a row
--     inserted now with fire_at = +5min will never fire early.
--   * clearCadenceWakes() now DELETEs from this table in addition to
--     cancelling the in-process timer, so a new schedule message arriving
--     while one is pending cannot leave a stale wake behind.
--   * The timer callback DELETEs the row before firing continueConversation,
--     matching the Map.delete() it replaces — a fire-and-replay cannot pick
--     the same row up twice across replicas.
--
-- lock_key shape mirrors cadenceWakes: `${sessionId}:${agentId}`. Multiple
-- sessions per workspace would each have their own key; the reaper scans by
-- next_fire_at, not by workspace_id, so cross-workspace scans remain cheap.

CREATE TABLE IF NOT EXISTS pending_cadence_wakes (
  lock_key text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  thread_parent_id uuid,
  next_fire_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- The reaper reads by next_fire_at. A partial index would be smaller, but
-- postgres treats a column index with a small cardinality-shaped predicate
-- similarly; keep it plain for now.
CREATE INDEX IF NOT EXISTS idx_pending_cadence_wakes_next_fire_at
  ON pending_cadence_wakes(next_fire_at);