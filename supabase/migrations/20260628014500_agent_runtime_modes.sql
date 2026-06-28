/*
  # Agent runtime modes

  Adds the fields needed for agensis agents that either run through the built-in
  backend assistant or connect as a remote daemon.
*/

ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS handle text DEFAULT '';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS connect_token_hash text DEFAULT '';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'builtin';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS permission_mode text NOT NULL DEFAULT 'default';
ALTER TABLE workspace_agents ALTER COLUMN avatar SET DEFAULT 'AI';

CREATE INDEX IF NOT EXISTS idx_workspace_agents_handle ON workspace_agents(workspace_id, handle);
CREATE INDEX IF NOT EXISTS idx_workspace_agents_connect_token_hash ON workspace_agents(connect_token_hash);
