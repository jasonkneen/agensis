/*
  # Sync runtime schema (F6, 2026-07 review)

  ensureRuntimeSchema (server/index.cjs) is the de-facto source of truth and had
  drifted ahead of this migrations directory + database/neon-schema.sql:
  thread_items and agent_registrations existed ONLY in the runtime DDL, and
  several `messages` columns (sender_kind/sender_id/sender_name/pinned/
  reactions/deleted_at) were runtime-only ALTERs too. Running `npm run migrate`
  with AGENSIS_RUNTIME_SCHEMA=false on a fresh DB previously produced a schema
  missing these — breaking the thread widget rail and agent registration.

  This migration brings a migrate-only DB to parity with the runtime schema.
*/

ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_kind text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_task_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(session_id, deleted_at);
CREATE INDEX IF NOT EXISTS idx_messages_source_task_id ON messages(session_id, source_task_id);

-- Conversation derivation columns are referenced by later privacy migrations,
-- so a fresh chronological migration run must establish them here rather than
-- depending on runtime startup to repair the database first.
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS parent_message_id uuid REFERENCES messages(id) ON DELETE CASCADE;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_parent_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS split_at timestamptz;
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent_message ON chat_sessions(parent_message_id);

-- Runtime/control columns that predate dedicated migrations. These are included
-- in this historical sync for clean installs and repeated in the newest
-- catch-up migration for databases that already recorded this migration.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_token_hash text DEFAULT '';
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS mcp_auto_approve boolean NOT NULL DEFAULT false;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS metadata jsonb DEFAULT '{}'::jsonb;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS memory_dir text DEFAULT '';
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS mcp_approved boolean NOT NULL DEFAULT false;
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS agent_id uuid;

CREATE TABLE IF NOT EXISTS thread_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'todo' CHECK (kind IN ('todo', 'plan', 'blocker')),
  content text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  order_index double precision NOT NULL DEFAULT 0,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  response text DEFAULT '',
  created_by uuid,
  created_by_agent text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_thread_items_session ON thread_items(session_id, kind, order_index);
CREATE INDEX IF NOT EXISTS idx_thread_items_workspace ON thread_items(workspace_id);

CREATE TABLE IF NOT EXISTS agent_registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  requested_handle text DEFAULT '',
  requested_name text DEFAULT '',
  client_label text DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  decided_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_agent_registrations_workspace ON agent_registrations(workspace_id, status);
