/*
  # Workspace folders, agent tools/webhooks, file storage metadata, and applets

  Adds local project association fields, chat folders/archive state, agent
  metadata, webhook entrypoints, stored file hashes, and the applet canvas type.
*/

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS local_path text DEFAULT '';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS project_kind text DEFAULT '';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_root text DEFAULT '';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS git_remote text DEFAULT '';

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_folder ON chat_sessions(workspace_id, folder);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(workspace_id, archived_at);

ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS soul text DEFAULT '';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS instructions text DEFAULT '';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS tools jsonb DEFAULT '[]'::jsonb;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS skills jsonb DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS agent_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  name text NOT NULL DEFAULT 'Webhook',
  token text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_webhooks_workspace_id ON agent_webhooks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent_id ON agent_webhooks(agent_id);

ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS content_sha256 text DEFAULT '';

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT con.conname INTO constraint_name
  FROM pg_constraint con
  JOIN pg_class rel ON rel.oid = con.conrelid
  WHERE rel.relname = 'canvas_objects'
    AND con.conname = 'canvas_objects_type_check'
  LIMIT 1;

  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE canvas_objects DROP CONSTRAINT %I', constraint_name);
  END IF;

  ALTER TABLE canvas_objects
    ADD CONSTRAINT canvas_objects_type_check
    CHECK (type IN ('rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen', 'text', 'image', 'video', 'file', 'applet', 'sticky_note'));
END $$;
