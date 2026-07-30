/*
  # Add user ownership and secure RLS policies

  1. Modified Tables
    - `workspaces` - added `user_id` (uuid) column referencing auth.users
      - Nullable to preserve existing seed data
      - Indexed for fast lookups

  2. Security Changes
    - Dropped ALL existing permissive `USING (true)` policies on every table
    - Replaced with strict ownership-based policies for `authenticated` role:
      - `workspaces`: user can only access their own workspaces (user_id = auth.uid())
      - `documents`: access derived through workspace ownership
      - `chat_sessions`: access derived through workspace ownership
      - `messages`: access derived through owning the parent chat session's workspace
      - `memory_facts`: access derived through workspace ownership
      - `uploaded_files`: access derived through workspace ownership

  3. Important Notes
    - Existing seed data has NULL user_id and will NOT be accessible until
      a user claims it or new data is created
    - Anonymous users can no longer read or write any data
    - All access now requires authentication via Supabase Auth
*/

-- Add user_id to workspaces
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'workspaces' AND column_name = 'user_id'
  ) THEN
    ALTER TABLE workspaces ADD COLUMN user_id uuid REFERENCES auth.users(id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

-- ============================================================
-- Drop all old permissive policies
-- ============================================================

-- workspaces
DROP POLICY IF EXISTS "Allow all on workspaces" ON workspaces;
DROP POLICY IF EXISTS "Allow insert on workspaces" ON workspaces;
DROP POLICY IF EXISTS "Allow update on workspaces" ON workspaces;
DROP POLICY IF EXISTS "Allow delete on workspaces" ON workspaces;

-- documents
DROP POLICY IF EXISTS "Allow all on documents" ON documents;
DROP POLICY IF EXISTS "Allow insert on documents" ON documents;
DROP POLICY IF EXISTS "Allow update on documents" ON documents;
DROP POLICY IF EXISTS "Allow delete on documents" ON documents;

-- chat_sessions
DROP POLICY IF EXISTS "Allow all on chat_sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Allow insert on chat_sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Allow update on chat_sessions" ON chat_sessions;
DROP POLICY IF EXISTS "Allow delete on chat_sessions" ON chat_sessions;

-- messages
DROP POLICY IF EXISTS "Allow all on messages" ON messages;
DROP POLICY IF EXISTS "Allow insert on messages" ON messages;
DROP POLICY IF EXISTS "Allow update on messages" ON messages;
DROP POLICY IF EXISTS "Allow delete on messages" ON messages;

-- memory_facts
DROP POLICY IF EXISTS "Allow all on memory_facts" ON memory_facts;
DROP POLICY IF EXISTS "Allow insert on memory_facts" ON memory_facts;
DROP POLICY IF EXISTS "Allow update on memory_facts" ON memory_facts;
DROP POLICY IF EXISTS "Allow delete on memory_facts" ON memory_facts;

-- uploaded_files
DROP POLICY IF EXISTS "Allow all on uploaded_files" ON uploaded_files;
DROP POLICY IF EXISTS "Allow insert on uploaded_files" ON uploaded_files;
DROP POLICY IF EXISTS "Allow update on uploaded_files" ON uploaded_files;
DROP POLICY IF EXISTS "Allow delete on uploaded_files" ON uploaded_files;

-- ============================================================
-- New secure policies: workspaces (ownership via user_id)
-- ============================================================

CREATE POLICY "Owner can view own workspaces"
  ON workspaces FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Owner can create workspaces"
  ON workspaces FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owner can update own workspaces"
  ON workspaces FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Owner can delete own workspaces"
  ON workspaces FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

-- ============================================================
-- New secure policies: documents (derived through workspace)
-- ============================================================

CREATE POLICY "Owner can view documents in own workspaces"
  ON documents FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = documents.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can create documents in own workspaces"
  ON documents FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = documents.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can update documents in own workspaces"
  ON documents FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = documents.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = documents.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can delete documents in own workspaces"
  ON documents FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = documents.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

-- ============================================================
-- New secure policies: chat_sessions (derived through workspace)
-- ============================================================

CREATE POLICY "Owner can view chat sessions in own workspaces"
  ON chat_sessions FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = chat_sessions.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can create chat sessions in own workspaces"
  ON chat_sessions FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = chat_sessions.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can update chat sessions in own workspaces"
  ON chat_sessions FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = chat_sessions.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = chat_sessions.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can delete chat sessions in own workspaces"
  ON chat_sessions FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = chat_sessions.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

-- ============================================================
-- New secure policies: messages (derived through session -> workspace)
-- ============================================================

CREATE POLICY "Owner can view messages in own chat sessions"
  ON messages FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      JOIN workspaces ON workspaces.id = chat_sessions.workspace_id
      WHERE chat_sessions.id = messages.session_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can create messages in own chat sessions"
  ON messages FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      JOIN workspaces ON workspaces.id = chat_sessions.workspace_id
      WHERE chat_sessions.id = messages.session_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can update messages in own chat sessions"
  ON messages FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      JOIN workspaces ON workspaces.id = chat_sessions.workspace_id
      WHERE chat_sessions.id = messages.session_id
      AND workspaces.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      JOIN workspaces ON workspaces.id = chat_sessions.workspace_id
      WHERE chat_sessions.id = messages.session_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can delete messages in own chat sessions"
  ON messages FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      JOIN workspaces ON workspaces.id = chat_sessions.workspace_id
      WHERE chat_sessions.id = messages.session_id
      AND workspaces.user_id = auth.uid()
    )
  );

-- ============================================================
-- New secure policies: memory_facts (derived through workspace)
-- ============================================================

CREATE POLICY "Owner can view memory facts in own workspaces"
  ON memory_facts FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = memory_facts.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can create memory facts in own workspaces"
  ON memory_facts FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = memory_facts.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can update memory facts in own workspaces"
  ON memory_facts FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = memory_facts.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = memory_facts.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can delete memory facts in own workspaces"
  ON memory_facts FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = memory_facts.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

-- ============================================================
-- New secure policies: uploaded_files (derived through workspace)
-- ============================================================

CREATE POLICY "Owner can view files in own workspaces"
  ON uploaded_files FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = uploaded_files.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can upload files to own workspaces"
  ON uploaded_files FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = uploaded_files.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can update files in own workspaces"
  ON uploaded_files FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = uploaded_files.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = uploaded_files.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );

CREATE POLICY "Owner can delete files in own workspaces"
  ON uploaded_files FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM workspaces
      WHERE workspaces.id = uploaded_files.workspace_id
      AND workspaces.user_id = auth.uid()
    )
  );
