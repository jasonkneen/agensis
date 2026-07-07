-- Adds the workspace_agents.metadata column used to store CursorBuddy
-- runtime/provider details separately from the `tools` array.
--
-- This was originally (and incorrectly) added by editing the already-applied
-- migration 0002, which changed that migration's checksum and broke the
-- Netlify database deploy. Rolling the change forward as its own migration is
-- the safe way to introduce the column. The backend reads this column
-- (JSON_COLUMNS_BY_TABLE / row serialization in backend.mjs), so it must exist.
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
