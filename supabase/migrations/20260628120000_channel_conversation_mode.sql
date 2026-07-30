/*
  # Channel conversation mode

  Adds per-channel multi-agent conversation settings to chat_sessions:
  - conversation_mode: 'mention' (agents reply when @mentioned) or 'auto'
    (mentioned agents take turns round-robin).
  - max_agent_turns: hard cap on agent replies triggered by one user message.
  - auto_rounds: number of round-robin rounds in 'auto' mode.
*/

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS conversation_mode text NOT NULL DEFAULT 'mention';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS max_agent_turns integer NOT NULL DEFAULT 10;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS auto_rounds integer NOT NULL DEFAULT 3;
