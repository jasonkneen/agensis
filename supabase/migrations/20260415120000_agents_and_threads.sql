/*
  # V2.1: workspace agents + chat threads

  1. New Tables
    - `workspace_agents` — named AI personas per workspace
    - Messages: add `thread_parent_id` for threaded replies

  2. Security
    - RLS via is_workspace_accessible()
*/

-- ============================================================
-- WORKSPACE AGENTS
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  avatar text NOT NULL DEFAULT '🤖',
  description text DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT 'auto',
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_agents_workspace_id ON workspace_agents(workspace_id);

ALTER TABLE workspace_agents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view workspace agents"
  ON workspace_agents FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create workspace agents"
  ON workspace_agents FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can update workspace agents"
  ON workspace_agents FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can delete workspace agents"
  ON workspace_agents FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

-- ============================================================
-- CHAT THREADS: add thread_parent_id to messages
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'messages' AND column_name = 'thread_parent_id'
  ) THEN
    ALTER TABLE messages ADD COLUMN thread_parent_id uuid REFERENCES messages(id) ON DELETE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_messages_thread_parent_id ON messages(thread_parent_id);
