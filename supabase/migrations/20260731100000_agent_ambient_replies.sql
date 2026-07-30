-- Per-agent off switch for ambient addressing: may this agent be drawn into a
-- channel post that named nobody?
--
-- DEFAULT true deliberately. Unprompted replies have been live for every 'auto'
-- channel since conversation_mode landed, so defaulting to false would silently
-- switch off shipped behaviour for every existing agent — the exact failure
-- shared/channelMentions.cjs was written to prevent (nothing errors; an agent
-- simply never speaks).
--
-- Explicit addressing is NEVER governed by this column: an @mention, @channel,
-- a DM and a reply inside the agent's own thread all dispatch regardless.
-- The per-CHANNEL switch is chat_sessions.conversation_mode = 'mention'.
ALTER TABLE workspace_agents
  ADD COLUMN IF NOT EXISTS ambient_replies boolean NOT NULL DEFAULT true;
