/*
  # Channel metadata

  Adds lightweight channel state to chat_sessions for favorite/archive UI and
  persisted people/agent membership without introducing a separate join table.
*/

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS is_favorite boolean NOT NULL DEFAULT false;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS participants jsonb NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_chat_sessions_favorite ON chat_sessions(workspace_id, is_favorite);
