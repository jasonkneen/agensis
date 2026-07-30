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
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(session_id, deleted_at);

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
