/*
  # Workspace-layer settings and version columns

  Adds version numbers to shared rows so clients can reason about updates, and
  adds document folders / workspace appearance fields for existing deployments.
*/

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS background_opacity numeric DEFAULT 0.42;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS folder text DEFAULT 'General';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(workspace_id, folder);

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE memory_facts ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE canvas_groups ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE canvas_objects ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE document_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE agent_webhooks ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS workspace_secrets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value text NOT NULL DEFAULT '',
  updated_by uuid,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace_id ON workspace_secrets(workspace_id);
