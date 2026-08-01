-- Forward half of the runtime-column parity repair. The same ALTERs also live
-- in 20260704000000_sync_runtime_schema.sql so a brand-new chronological
-- migration run has the derivation columns before later privacy/index
-- migrations reference them. This file repairs databases that already recorded
-- that older migration.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_token_hash text DEFAULT '';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_auto_approve boolean NOT NULL DEFAULT false;

ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_provider text;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_config jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS memory_dir text DEFAULT '';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS mcp_approved boolean NOT NULL DEFAULT false;

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS parent_message_id uuid REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_parent_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_at timestamptz;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent_message ON chat_sessions(parent_message_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_task_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_source_task_id ON messages(session_id, source_task_id);
CREATE INDEX IF NOT EXISTS idx_messages_source_task_root
  ON messages(source_task_id)
  WHERE source_task_id IS NOT NULL AND thread_parent_id IS NULL;

ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS agent_id uuid;
