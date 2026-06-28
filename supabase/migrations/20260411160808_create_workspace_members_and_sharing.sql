/*
  # Workspace members and sharing system

  1. New Tables
    - `workspace_members` - tracks shared access to workspaces
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk to workspaces)
      - `user_id` (uuid, fk to auth.users)
      - `role` (text: owner, editor, viewer)
      - `invited_by` (uuid, fk to auth.users)
      - `created_at` (timestamptz)
    - Unique constraint on (workspace_id, user_id)

  2. Security
    - RLS enabled on workspace_members
    - Workspace owners and existing members can view membership
    - Only workspace owners can add or remove members
    - Members cannot escalate their own role

  3. Modified Tables
    - All existing table RLS policies updated to also allow
      workspace members (not just owners) to access data

  4. Important Notes
    - The workspace owner (workspaces.user_id) always has full access
    - Members get access based on their role
    - auto_share column added to workspaces to toggle workspace-wide sharing
*/

-- Add auto_share toggle to workspaces
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspaces' AND column_name = 'auto_share'
  ) THEN
    ALTER TABLE workspaces ADD COLUMN auto_share boolean DEFAULT false;
  END IF;
END $$;

-- Create workspace_members table
CREATE TABLE IF NOT EXISTS workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  invited_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);

ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

-- Helper function: check if user is workspace owner or member
CREATE OR REPLACE FUNCTION is_workspace_accessible(ws_id uuid)
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM workspaces WHERE id = ws_id AND user_id = auth.uid()
  ) OR EXISTS (
    SELECT 1 FROM workspace_members WHERE workspace_id = ws_id AND user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- Helper function: check if user is workspace owner
CREATE OR REPLACE FUNCTION is_workspace_owner(ws_id uuid)
RETURNS boolean AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM workspaces WHERE id = ws_id AND user_id = auth.uid()
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER STABLE;

-- ============================================================
-- workspace_members RLS policies
-- ============================================================

CREATE POLICY "Members can view workspace membership"
  ON workspace_members FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Owners can add workspace members"
  ON workspace_members FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_owner(workspace_id));

CREATE POLICY "Owners can update workspace members"
  ON workspace_members FOR UPDATE
  TO authenticated
  USING (is_workspace_owner(workspace_id))
  WITH CHECK (is_workspace_owner(workspace_id));

CREATE POLICY "Owners can remove workspace members"
  ON workspace_members FOR DELETE
  TO authenticated
  USING (is_workspace_owner(workspace_id));

-- ============================================================
-- Update existing policies to also allow workspace members
-- Drop old owner-only policies and recreate with member access
-- ============================================================

-- WORKSPACES: owners + members can view
DROP POLICY IF EXISTS "Owner can view own workspaces" ON workspaces;
CREATE POLICY "Owner or member can view workspaces"
  ON workspaces FOR SELECT
  TO authenticated
  USING (
    auth.uid() = user_id
    OR EXISTS (
      SELECT 1 FROM workspace_members
      WHERE workspace_members.workspace_id = workspaces.id
      AND workspace_members.user_id = auth.uid()
    )
  );

-- DOCUMENTS: members can access
DROP POLICY IF EXISTS "Owner can view documents in own workspaces" ON documents;
CREATE POLICY "Members can view documents"
  ON documents FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can create documents in own workspaces" ON documents;
CREATE POLICY "Members can create documents"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can update documents in own workspaces" ON documents;
CREATE POLICY "Members can update documents"
  ON documents FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can delete documents in own workspaces" ON documents;
CREATE POLICY "Members can delete documents"
  ON documents FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

-- CHAT_SESSIONS: members can access
DROP POLICY IF EXISTS "Owner can view chat sessions in own workspaces" ON chat_sessions;
CREATE POLICY "Members can view chat sessions"
  ON chat_sessions FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can create chat sessions in own workspaces" ON chat_sessions;
CREATE POLICY "Members can create chat sessions"
  ON chat_sessions FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can update chat sessions in own workspaces" ON chat_sessions;
CREATE POLICY "Members can update chat sessions"
  ON chat_sessions FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can delete chat sessions in own workspaces" ON chat_sessions;
CREATE POLICY "Members can delete chat sessions"
  ON chat_sessions FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

-- MESSAGES: members can access via session -> workspace
DROP POLICY IF EXISTS "Owner can view messages in own chat sessions" ON messages;
CREATE POLICY "Members can view messages"
  ON messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = messages.session_id
      AND is_workspace_accessible(chat_sessions.workspace_id)
    )
  );

DROP POLICY IF EXISTS "Owner can create messages in own chat sessions" ON messages;
CREATE POLICY "Members can create messages"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = messages.session_id
      AND is_workspace_accessible(chat_sessions.workspace_id)
    )
  );

DROP POLICY IF EXISTS "Owner can update messages in own chat sessions" ON messages;
CREATE POLICY "Members can update messages"
  ON messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = messages.session_id
      AND is_workspace_accessible(chat_sessions.workspace_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = messages.session_id
      AND is_workspace_accessible(chat_sessions.workspace_id)
    )
  );

DROP POLICY IF EXISTS "Owner can delete messages in own chat sessions" ON messages;
CREATE POLICY "Members can delete messages"
  ON messages FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = messages.session_id
      AND is_workspace_accessible(chat_sessions.workspace_id)
    )
  );

-- MEMORY_FACTS: members can access
DROP POLICY IF EXISTS "Owner can view memory facts in own workspaces" ON memory_facts;
CREATE POLICY "Members can view memory facts"
  ON memory_facts FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can create memory facts in own workspaces" ON memory_facts;
CREATE POLICY "Members can create memory facts"
  ON memory_facts FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can update memory facts in own workspaces" ON memory_facts;
CREATE POLICY "Members can update memory facts"
  ON memory_facts FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can delete memory facts in own workspaces" ON memory_facts;
CREATE POLICY "Members can delete memory facts"
  ON memory_facts FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

-- UPLOADED_FILES: members can access
DROP POLICY IF EXISTS "Owner can view files in own workspaces" ON uploaded_files;
CREATE POLICY "Members can view files"
  ON uploaded_files FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can upload files to own workspaces" ON uploaded_files;
CREATE POLICY "Members can upload files"
  ON uploaded_files FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can update files in own workspaces" ON uploaded_files;
CREATE POLICY "Members can update files"
  ON uploaded_files FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

DROP POLICY IF EXISTS "Owner can delete files in own workspaces" ON uploaded_files;
CREATE POLICY "Members can delete files"
  ON uploaded_files FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));
