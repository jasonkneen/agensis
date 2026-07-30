/*
  # V2 team primitives: tasks, document comments, activity events

  1. New Tables
    - `tasks` — first-class action items scoped to a workspace
      - id, workspace_id, created_by, assignee_id
      - title, description, status, priority, due_date
      - source_type, source_id (link back to doc/chat/canvas)
      - completed_at, created_at, updated_at
    - `document_comments` — threaded comments anchored to documents
      - id, document_id, workspace_id, user_id, parent_id
      - content, anchor_text, resolved
      - created_at, updated_at
    - `activity_events` — append-only workspace activity feed
      - id, workspace_id, user_id, event_type, entity_type
      - entity_id, title, metadata, created_at

  2. Security
    - RLS enabled on all three
    - Read/write gated by existing is_workspace_accessible()
    - activity_events is insert+select only (immutable feed)

  3. Notes
    - All tables cascade from workspaces
    - Indexes on workspace_id + created_at for fast feed queries
*/

-- ============================================================
-- TASKS
-- ============================================================

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  assignee_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL,
  description text DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date timestamptz,
  source_type text CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai')),
  source_id text,
  completed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(workspace_id, updated_at DESC);

ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view tasks"
  ON tasks FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create tasks"
  ON tasks FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can update tasks"
  ON tasks FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can delete tasks"
  ON tasks FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

-- ============================================================
-- DOCUMENT COMMENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS document_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES document_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  anchor_text text DEFAULT '',
  resolved boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_comments_document_id ON document_comments(document_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_workspace_id ON document_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_parent_id ON document_comments(parent_id);

ALTER TABLE document_comments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view document comments"
  ON document_comments FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create document comments"
  ON document_comments FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can update document comments"
  ON document_comments FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can delete document comments"
  ON document_comments FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

-- ============================================================
-- ACTIVITY EVENTS (append-only feed)
-- ============================================================

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  title text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_workspace_created ON activity_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_entity ON activity_events(entity_type, entity_id);

ALTER TABLE activity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view activity events"
  ON activity_events FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create activity events"
  ON activity_events FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));
