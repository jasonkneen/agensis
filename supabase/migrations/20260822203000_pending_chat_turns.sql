-- Parked chat turns, made durable.
--
-- A human message that arrives while its agent is mid-turn is PARKED and
-- replayed when that turn ends (the 2026-08-03 dropped-DM-turn fix). The park
-- lived only in process memory, which the comment on it justified as
-- "best-effort — losing one on restart is the pre-fix behaviour".
--
-- That stopped being acceptable on 2026-08-22: a request parked at 18:10, a
-- deploy restarted the backend at 18:17, and the turn vanished inside the
-- 15-minute window where it was still owed an answer. The human noticed the
-- silence before the server did.
--
-- The in-process Map is still the live structure; this table is its shadow, read
-- once at startup (restorePendingChatTurns) and re-driven by
-- replayOrphanedChatTurns.
--
-- park_key is `<session>::<agent>` as TEXT rather than a composite primary key,
-- because the agent half is empty for a turn parked by the conversation-lock
-- branch — that branch runs before any agent has been elected, and NULL cannot
-- carry a primary key.

CREATE TABLE IF NOT EXISTS pending_chat_turns (
  park_key text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  -- NULL for a lock-parked turn: the replay re-elects. CASCADE because a deleted
  -- agent's parked turn can never be replayed as that agent.
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
  thread_parent_id uuid,
  broadcast_to_channel boolean,
  target_agent_id uuid,
  attempts integer NOT NULL DEFAULT 0,
  parked_at timestamptz NOT NULL DEFAULT now()
);

-- restorePendingChatTurns deletes by age on every boot.
CREATE INDEX IF NOT EXISTS idx_pending_chat_turns_parked_at ON pending_chat_turns(parked_at);
