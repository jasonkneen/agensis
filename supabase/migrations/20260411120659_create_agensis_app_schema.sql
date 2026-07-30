/*
  # agensis App - Core Schema

  1. Tables
    - `workspaces` - isolated user workspaces
      - `id` (uuid, pk)
      - `name` (text)
      - `description` (text)
      - `icon` (text, emoji or icon name)
      - `created_at`, `updated_at`

    - `documents` - rich text documents per workspace
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk)
      - `title` (text)
      - `content` (text - HTML rich content)
      - `is_favorite` (bool)
      - `created_at`, `updated_at`

    - `chat_sessions` - chat conversations per workspace
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk)
      - `title` (text)
      - `model` (text - AI model used)
      - `created_at`, `updated_at`

    - `messages` - chat messages within sessions
      - `id` (uuid, pk)
      - `session_id` (uuid, fk)
      - `role` (text - user/assistant)
      - `content` (text)
      - `created_at`

    - `memory_facts` - persistent user memory facts
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk)
      - `fact` (text)
      - `category` (text)
      - `created_at`, `updated_at`

    - `uploaded_files` - file metadata
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk)
      - `name` (text)
      - `size` (bigint)
      - `type` (text)
      - `storage_path` (text)
      - `created_at`

  2. Security
    - RLS enabled on all tables
    - Policies allow all operations (no auth in this app)

  3. Notes
    - A default workspace is seeded
    - All timestamps use timestamptz
*/

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'My Workspace',
  description text DEFAULT '',
  icon text DEFAULT '🏠',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled',
  content text DEFAULT '',
  is_favorite boolean DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New Chat',
  model text DEFAULT 'claude-opus-4-6',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS memory_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  fact text NOT NULL DEFAULT '',
  category text DEFAULT 'general',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  size bigint DEFAULT 0,
  type text DEFAULT '',
  storage_path text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE uploaded_files ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow all on workspaces"
  ON workspaces FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert on workspaces"
  ON workspaces FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update on workspaces"
  ON workspaces FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete on workspaces"
  ON workspaces FOR DELETE TO anon USING (true);

CREATE POLICY "Allow all on documents"
  ON documents FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert on documents"
  ON documents FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update on documents"
  ON documents FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete on documents"
  ON documents FOR DELETE TO anon USING (true);

CREATE POLICY "Allow all on chat_sessions"
  ON chat_sessions FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert on chat_sessions"
  ON chat_sessions FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update on chat_sessions"
  ON chat_sessions FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete on chat_sessions"
  ON chat_sessions FOR DELETE TO anon USING (true);

CREATE POLICY "Allow all on messages"
  ON messages FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert on messages"
  ON messages FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update on messages"
  ON messages FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete on messages"
  ON messages FOR DELETE TO anon USING (true);

CREATE POLICY "Allow all on memory_facts"
  ON memory_facts FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert on memory_facts"
  ON memory_facts FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update on memory_facts"
  ON memory_facts FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete on memory_facts"
  ON memory_facts FOR DELETE TO anon USING (true);

CREATE POLICY "Allow all on uploaded_files"
  ON uploaded_files FOR SELECT TO anon USING (true);
CREATE POLICY "Allow insert on uploaded_files"
  ON uploaded_files FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Allow update on uploaded_files"
  ON uploaded_files FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Allow delete on uploaded_files"
  ON uploaded_files FOR DELETE TO anon USING (true);

INSERT INTO workspaces (id, name, description, icon)
VALUES ('00000000-0000-0000-0000-000000000001', 'Personal', 'Your personal workspace', '🌱')
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspaces (id, name, description, icon)
VALUES ('00000000-0000-0000-0000-000000000002', 'Work', 'Professional workspace', '💼')
ON CONFLICT (id) DO NOTHING;

INSERT INTO documents (workspace_id, title, content)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'Getting Started',
  '<h1>Welcome to agensis</h1><p>This is your intelligent workspace. Start writing, chatting with AI, or uploading files to get started.</p><h2>What you can do</h2><ul><li>Write and organize documents</li><li>Chat with AI models</li><li>Upload context files</li><li>Save important memories</li></ul>'
)
ON CONFLICT DO NOTHING;

INSERT INTO memory_facts (workspace_id, fact, category)
VALUES 
  ('00000000-0000-0000-0000-000000000001', 'I prefer concise, direct responses', 'preferences'),
  ('00000000-0000-0000-0000-000000000001', 'I am a software developer', 'about me')
ON CONFLICT DO NOTHING;
