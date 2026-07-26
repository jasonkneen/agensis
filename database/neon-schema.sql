CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Server-managed settings (e.g. API keys). Stored in the DB so they work on
-- serverless deploys with a read-only filesystem (Netlify/Vercel), not just
-- where a writable .env exists. Intentionally NOT exposed via the generic
-- /backend/db/* endpoints — only the dedicated /backend/settings routes read
-- or write it, and reads return masked values.
CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value text NOT NULL DEFAULT '',
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  display_name text DEFAULT '',
  accent_color text DEFAULT '',
  -- Plan 005: bumped on sign-out / password change to invalidate every
  -- outstanding session token for this user (embedded in the token; verifyToken
  -- rejects a token whose embedded version no longer matches this column).
  token_version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL DEFAULT 'My Workspace',
  description text DEFAULT '',
  icon text DEFAULT '🏠',
  user_id uuid,
  auto_share boolean DEFAULT false,
  local_path text DEFAULT '',
  project_kind text DEFAULT '',
  git_root text DEFAULT '',
  git_remote text DEFAULT '',
  background_opacity numeric DEFAULT 0.42,
  background_image text DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

CREATE TABLE IF NOT EXISTS workspace_secrets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  -- Legacy plaintext column. Encrypted rows leave this empty and carry the
  -- AES-256-GCM ciphertext in secret_cipher instead.
  value text NOT NULL DEFAULT '',
  secret_cipher text DEFAULT '',
  description text DEFAULT '',
  updated_by uuid,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);

-- M10 (2026-07 review): secret_cipher/description were added ONLY by the runtime
-- ALTERs in server/index.cjs, so a DB provisioned from this file (or from the
-- migrations) had neither. Re-stated as idempotent ALTERs so re-pushing this file
-- over an existing database backfills them too.
ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS secret_cipher text DEFAULT '';
ALTER TABLE workspace_secrets ADD COLUMN IF NOT EXISTS description text DEFAULT '';

CREATE INDEX IF NOT EXISTS idx_workspace_secrets_workspace_id ON workspace_secrets(workspace_id);

CREATE TABLE IF NOT EXISTS gateway_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Gateway',
  base_url text NOT NULL DEFAULT '',
  api_key_cipher text NOT NULL DEFAULT '',
  model text NOT NULL DEFAULT '',
  protocol text NOT NULL DEFAULT 'openai-chat',
  headers jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_gateway_configs_workspace_id ON gateway_configs(workspace_id);

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'Untitled',
  content text DEFAULT '',
  is_favorite boolean DEFAULT false,
  folder text DEFAULT 'General',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_documents_workspace_id ON documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_documents_folder ON documents(workspace_id, folder);
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_documents_title_trgm ON documents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_documents_content_trgm ON documents USING gin (content gin_trgm_ops);

CREATE TABLE IF NOT EXISTS chat_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  title text NOT NULL DEFAULT 'New Chat',
  model text DEFAULT 'auto',
  folder text DEFAULT 'General',
  is_favorite boolean NOT NULL DEFAULT false,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  conversation_mode text NOT NULL DEFAULT 'auto',
  max_agent_turns integer NOT NULL DEFAULT 10,
  auto_rounds integer NOT NULL DEFAULT 3,
  parent_message_id uuid,
  split_parent_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  split_at timestamptz,
  archived_at timestamptz,
  deleted_at timestamptz,
  canvas_id text,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_id ON chat_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_folder ON chat_sessions(workspace_id, folder);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_favorite ON chat_sessions(workspace_id, is_favorite);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_canvas ON chat_sessions(workspace_id, canvas_id);

-- message_kind/tool_name/tool_detail carry agent tool steps: message_kind
-- 'tool_step' marks a row the UI renders as a compact chip rather than a full
-- chat bubble, and the two tool_* halves are the structured form of the
-- human-readable `content` line, which stays populated as the fallback. All
-- three default to '' so every pre-existing row stays valid.
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('user', 'assistant')),
  content text NOT NULL DEFAULT '',
  message_kind text DEFAULT '',
  tool_name text DEFAULT '',
  tool_detail text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);

-- Threaded replies: a message may be a reply to another message.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS thread_parent_id uuid REFERENCES messages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_messages_thread_parent_id ON messages(thread_parent_id);

-- chat_sessions.parent_message_id references messages, but chat_sessions is
-- created first (messages FK it via session_id), so the FK is added here once
-- both tables exist. Matches the runtime ALTER in server/index.cjs.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chat_sessions_parent_message_id_fkey') THEN
    ALTER TABLE chat_sessions ADD CONSTRAINT chat_sessions_parent_message_id_fkey
      FOREIGN KEY (parent_message_id) REFERENCES messages(id) ON DELETE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_parent_message ON chat_sessions(parent_message_id);

-- F6 (2026-07 review): these columns (agent-attributed sends, pin/react, soft
-- delete) were added via runtime ALTER ... IF NOT EXISTS in server/index.cjs
-- but were missing here, so a fresh `npm run migrate` DB never got them.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_kind text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_id text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender_name text DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS pinned boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions jsonb DEFAULT '{}';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(session_id, deleted_at);

-- "Send to channel": an agent WORKS inside a thread and only its final answer is
-- broadcast to the channel/DM. A broadcast reply KEEPS its thread_parent_id (it is
-- still part of the thread) and is additionally shown in the channel view, so the
-- channel reads as message → answer while every "Thinking …" placeholder,
-- tool-step chip and intermediate text block stays in the thread. Humans get the
-- same switch from the thread composer. Mirrors the runtime ALTER in
-- server/index.cjs and supabase/migrations/20260725160000_*.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast_to_channel boolean NOT NULL DEFAULT false;

-- Tasks <-> subthread <-> comments loop: a task @mention runs the agent inside a
-- per-task subthread; source_task_id ties the thread root back to its task.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS source_task_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_source_task_id ON messages(session_id, source_task_id);

-- Trigram GIN indexes so MCP search_messages / search_docs (leading-wildcard
-- ILIKE '%q%') are index-backed instead of a full sequential scan. Mirrors the
-- runtime bootstrap DDL in server/index.cjs.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages USING gin (content gin_trgm_ops);

CREATE TABLE IF NOT EXISTS flow_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Flows',
  token_hash text NOT NULL UNIQUE,
  signing_secret_cipher text NOT NULL,
  webhook_url text,
  events jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flow_connections_workspace ON flow_connections(workspace_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_flow_connections_channel ON flow_connections(channel_id, revoked_at);

CREATE TABLE IF NOT EXISTS flow_webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES flow_connections(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'inflight', 'delivered', 'dead')),
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (connection_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_flow_deliveries_due ON flow_webhook_deliveries(status, next_attempt_at);

-- F6 (2026-07 review): thread_items existed ONLY in the runtime DDL
-- (ensureRuntimeSchema, server/index.cjs) — a fresh migrate DB never got it,
-- breaking the thread widget rail (create_thread_item / update_thread_item).
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

CREATE TABLE IF NOT EXISTS memory_facts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  fact text NOT NULL DEFAULT '',
  category text DEFAULT 'general',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_workspace_id ON memory_facts(workspace_id);

-- Defined here (before agent_memory_files / memory_file_comments) because both
-- of those FK it. psql runs this file top to bottom with ON_ERROR_STOP=1, so a
-- forward REFERENCES aborts the whole push — keep referenced tables above their
-- referrers.
CREATE TABLE IF NOT EXISTS workspace_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  avatar text NOT NULL DEFAULT 'AI',
  openpet_avatar_id text DEFAULT '',
  accent_color text DEFAULT '#00a95c',
  description text DEFAULT '',
  system_prompt text NOT NULL DEFAULT '',
  soul text DEFAULT '',
  instructions text DEFAULT '',
  tools jsonb DEFAULT '[]'::jsonb,
  skills jsonb DEFAULT '[]'::jsonb,
  handle text DEFAULT '',
  connect_token_hash text DEFAULT '',
  model text NOT NULL DEFAULT 'auto',
  run_mode text NOT NULL DEFAULT 'builtin',
  memory_dir text DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  permission_mode text NOT NULL DEFAULT 'default',
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_agents_workspace_id ON workspace_agents(workspace_id);

-- Agent file-memory mirror: read-only snapshots of the memory files an agent's
-- daemon enumerates from its palace dir. Pushed up by the daemon; never edited
-- in-app in phase 1. UPSERTed by UNIQUE(agent_id, path) so re-syncs update rows
-- in place (comments anchor to the stable (agent_id, path) identity, not the row).
CREATE TABLE IF NOT EXISTS agent_memory_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  path text NOT NULL,
  kind text NOT NULL DEFAULT 'memory',
  summary text DEFAULT '',
  content_cache text DEFAULT '',
  byte_size bigint DEFAULT 0,
  editable boolean NOT NULL DEFAULT false,
  last_synced timestamptz DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (agent_id, path)
);

CREATE INDEX IF NOT EXISTS idx_agent_memory_files_workspace_id ON agent_memory_files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_files_agent_id ON agent_memory_files(agent_id);

CREATE TABLE IF NOT EXISTS uploaded_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  size bigint DEFAULT 0,
  type text DEFAULT '',
  storage_path text DEFAULT '',
  content_sha256 text DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_uploaded_files_workspace_id ON uploaded_files(workspace_id);

CREATE TABLE IF NOT EXISTS workspace_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('owner', 'admin', 'editor', 'commenter', 'viewer')),
  invited_by uuid,
  created_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace_id ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_user_id ON workspace_members(user_id);

-- Invite links. This table existed ONLY in the runtime DDL (ensureRuntimeSchema,
-- server/index.cjs) — a fresh `npm run db:neon:push` / `npm run migrate` DB never
-- got it, so every invite route 500'd there. Restated here (and in
-- supabase/migrations/20260726120000_*) to match the runtime bootstrap exactly.
--
-- `token` holds hashAgentToken(plaintext) for rows created after the L4
-- hardening; the plaintext is returned once, at creation, and never again.
--
-- `dismissed_at` is a soft delete for the LIST only: a spent link (revoked,
-- accepted, or past expires_at) can be cleared out of the Users window while the
-- row survives — an accepted invite is the record of how a member got into the
-- workspace. NULL = shown. The routes refuse to set it on a still-active link,
-- because hiding a live invite would leave it granting access with nowhere left
-- to see or revoke it.
CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  email text DEFAULT '',
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  accepted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  expires_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Idempotent so re-pushing this file over an existing database backfills the
-- column on a table that predates it.
ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token);

CREATE TABLE IF NOT EXISTS canvas_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Untitled Group',
  color text NOT NULL DEFAULT '#3b82f6',
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_groups_workspace_id ON canvas_groups(workspace_id);

-- Canvas layers (the "projects"/canvases a workspace is split into). The shared
-- definition — name and ordering — of each layer, so a canvas one member creates
-- is visible to the rest of the workspace. `layer_id` is the client-generated
-- text id that canvas_objects.layer_id stores ('base' for the default layer); the
-- uuid `id` is the row's own key so every generic /backend/db row id stays
-- globally unique (the RBAC gate resolves a row's workspace from a bare id
-- filter). Which layer is active is per-browser and stays in localStorage.
CREATE TABLE IF NOT EXISTS canvas_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  layer_id text NOT NULL,
  name text NOT NULL DEFAULT 'Workspace',
  sort_order double precision NOT NULL DEFAULT 0,
  description text DEFAULT '',
  icon text DEFAULT '',
  local_path text DEFAULT '',
  project_kind text DEFAULT '',
  git_root text DEFAULT '',
  git_remote text DEFAULT '',
  background_opacity double precision DEFAULT 0.42,
  background_image text DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, layer_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_layers_workspace_id ON canvas_layers(workspace_id);

CREATE TABLE IF NOT EXISTS canvas_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  type text NOT NULL DEFAULT 'rect' CHECK (type IN ('rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen', 'text', 'image', 'video', 'file', 'applet', 'sticky_note')),
  x double precision NOT NULL DEFAULT 50,
  y double precision NOT NULL DEFAULT 50,
  width double precision NOT NULL DEFAULT 10,
  height double precision NOT NULL DEFAULT 10,
  rotation double precision NOT NULL DEFAULT 0,
  fill text NOT NULL DEFAULT '#4f9cf9',
  stroke text NOT NULL DEFAULT 'transparent',
  stroke_width double precision NOT NULL DEFAULT 2,
  opacity double precision NOT NULL DEFAULT 1,
  points jsonb DEFAULT '[]'::jsonb,
  text_content text DEFAULT '',
  src text DEFAULT '',
  file_name text DEFAULT '',
  z_index integer NOT NULL DEFAULT 0,
  locked boolean NOT NULL DEFAULT false,
  group_id uuid REFERENCES canvas_groups(id) ON DELETE SET NULL,
  attached_to uuid REFERENCES canvas_objects(id) ON DELETE SET NULL,
  font_size integer DEFAULT 14,
  layer_id text DEFAULT 'base',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_objects_workspace_id ON canvas_objects(workspace_id);
CREATE INDEX IF NOT EXISTS idx_canvas_objects_group_id ON canvas_objects(group_id);
CREATE INDEX IF NOT EXISTS idx_canvas_objects_attached_to ON canvas_objects(attached_to);
CREATE INDEX IF NOT EXISTS idx_canvas_objects_workspace_layer_id ON canvas_objects(workspace_id, layer_id);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by uuid,
  assignee_id uuid,
  title text NOT NULL,
  description text DEFAULT '',
  status text NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'done', 'cancelled')),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  due_date timestamptz,
  source_type text CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai')),
  source_id text,
  completed_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Sub-tasks / nesting: a task may have a parent task.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE;
-- Gantt scheduling + dependency graph (added with the List/Kanban/Gantt views).
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_date timestamptz;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS depends_on uuid[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_id ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee_id ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_updated_at ON tasks(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);

CREATE TABLE IF NOT EXISTS document_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  parent_id uuid REFERENCES document_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  anchor_text text DEFAULT '',
  resolved boolean DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_comments_document_id ON document_comments(document_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_workspace_id ON document_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_document_comments_parent_id ON document_comments(parent_id);

-- Comments layered on agent memory files. Anchored to the stable (agent_id, path)
-- identity rather than a FK to agent_memory_files.id, so comments survive a re-sync
-- that rewrites file rows or even a file being removed from the mirror.
CREATE TABLE IF NOT EXISTS memory_file_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  path text NOT NULL,
  user_id uuid,
  parent_id uuid REFERENCES memory_file_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  anchor_text text DEFAULT '',
  resolved boolean DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_memory_file_comments_workspace_id ON memory_file_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_file_comments_agent_path ON memory_file_comments(agent_id, path);
CREATE INDEX IF NOT EXISTS idx_memory_file_comments_parent_id ON memory_file_comments(parent_id);

-- F10 (2026-07 review): `token` holds hashAgentToken(plaintext) for rows created
-- after the hardening fix (server/index.cjs POST /backend/agent-webhooks) — the
-- plaintext is only ever returned once, at creation. Legacy rows may still hold
-- plaintext; the trigger route's dual-path lookup (inviteTokenLookupParams)
-- matches either during the transition. No column/type change needed.
CREATE TABLE IF NOT EXISTS agent_webhooks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  name text NOT NULL DEFAULT 'Webhook',
  token text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  last_triggered_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_webhooks_workspace_id ON agent_webhooks(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_webhooks_agent_id ON agent_webhooks(agent_id);

-- F6 (2026-07 review): agent_registrations existed ONLY in the runtime DDL —
-- a fresh migrate DB never got it, breaking MCP register_agent/approval flows.
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

CREATE TABLE IF NOT EXISTS agent_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Agent',
  handle text NOT NULL DEFAULT '',
  host text DEFAULT '',
  cwd text DEFAULT '',
  status text NOT NULL DEFAULT 'offline' CHECK (status IN ('online', 'offline', 'busy')),
  metadata jsonb DEFAULT '{}'::jsonb,
  capabilities jsonb DEFAULT '{}'::jsonb,
  connected_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS farm_integration_device_codes (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'Agent Farm',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  approved_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  denied_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  integration_id uuid,
  expires_at timestamptz NOT NULL,
  approved_at timestamptz,
  denied_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_farm_device_user_code ON farm_integration_device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_farm_device_expires_at ON farm_integration_device_codes(expires_at);

CREATE TABLE IF NOT EXISTS farm_integrations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Agent Farm',
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  approved_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_farm_integrations_workspace ON farm_integrations(workspace_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace_id ON agent_connections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_connections_agent_id ON agent_connections(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_connections_status ON agent_connections(workspace_id, status);

CREATE TABLE IF NOT EXISTS cursorbuddy_connection_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  key_hash text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'CursorBuddy runtime',
  surface text NOT NULL DEFAULT 'machine',
  scope text NOT NULL DEFAULT 'machine',
  domain text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'claimed', 'expired', 'revoked')),
  metadata jsonb DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  claimed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_workspace ON cursorbuddy_connection_keys(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_hash ON cursorbuddy_connection_keys(key_hash);

CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  version_number integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc_version ON document_versions(document_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_workspace_id ON document_versions(workspace_id);

CREATE TABLE IF NOT EXISTS task_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  parent_id uuid REFERENCES task_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  resolved boolean DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Agent-authored comments (a mirrored subthread reply) attribute to an agent, not a user.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS agent_id uuid;

CREATE INDEX IF NOT EXISTS idx_task_comments_task_id ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_workspace_id ON task_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_task_comments_parent_id ON task_comments(parent_id);

CREATE TABLE IF NOT EXISTS activity_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  event_type text NOT NULL,
  entity_type text,
  entity_id text,
  title text NOT NULL,
  metadata jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_activity_events_workspace_created ON activity_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_activity_events_entity ON activity_events(entity_type, entity_id);

-- Notes left on an activity log entry ("comment I can look at later"), anchored
-- to the activity_events row itself. Mirrors memory_file_comments' shape.
CREATE TABLE IF NOT EXISTS activity_event_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id uuid NOT NULL REFERENCES activity_events(id) ON DELETE CASCADE,
  user_id uuid,
  parent_id uuid REFERENCES activity_event_comments(id) ON DELETE CASCADE,
  content text NOT NULL,
  resolved boolean DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_event_comments_workspace_id ON activity_event_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_activity_event_comments_event_id ON activity_event_comments(event_id);
CREATE INDEX IF NOT EXISTS idx_activity_event_comments_parent_id ON activity_event_comments(parent_id);

-- Inbox read state: one MONOTONIC marker per (user, workspace, context_key).
-- The inbox aggregates existing sources (blockers, comments, mentions, agent-job
-- errors, activity) and owns no rows of its own — read/unread is entirely this
-- table: an item is unread when its created_at is newer than the marker for its
-- context_key, or when no marker exists. Markers only ever move FORWARD (the
-- upsert in server/index.cjs carries a `read_at < excluded.read_at` guard) so a
-- stale write from a second device cannot un-read something.
--
-- The primary key IS the read-path index: the inbox query looks markers up by
-- the (user_id, workspace_id) prefix, which the PK btree covers. The extra
-- workspace_id index only serves the ON DELETE CASCADE from workspaces.
CREATE TABLE IF NOT EXISTS inbox_read_state (
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_key text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id, context_key)
);
CREATE INDEX IF NOT EXISTS idx_inbox_read_state_workspace ON inbox_read_state(workspace_id);

-- Scheduled agent runs. A schedule posts a prompt into a session on a cadence
-- (interval_seconds) and lets the orchestrator dispatch. Mirrors the runtime
-- bootstrap DDL in server/index.cjs so a fresh neon-push has the tables too.
CREATE TABLE IF NOT EXISTS agent_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  created_by uuid,
  name text NOT NULL DEFAULT '',
  prompt text NOT NULL DEFAULT '',
  interval_seconds integer NOT NULL DEFAULT 86400,
  enabled boolean NOT NULL DEFAULT true,
  running boolean NOT NULL DEFAULT false,
  next_run_at timestamptz NOT NULL DEFAULT now(),
  last_run_at timestamptz,
  last_status text DEFAULT '',
  run_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_workspace_id ON agent_schedules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due ON agent_schedules(next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS agent_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ok',
  detail text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule ON agent_schedule_runs(schedule_id, created_at desc);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_schedules_interval_bounds') THEN
    ALTER TABLE agent_schedules ADD CONSTRAINT agent_schedules_interval_bounds
      CHECK (interval_seconds >= 60 AND interval_seconds <= 2592000);
  END IF;
END $$;

-- Huddles: ad-hoc voice calls inside a channel, carried by LiveKit. Mirrors the
-- runtime bootstrap DDL in server/huddles.cjs (HUDDLES_SCHEMA_SQL) so a fresh
-- neon-push has the tables too. room_name is namespaced 'agensis-<huddleId>'
-- because the LiveKit project is shared with other apps.
-- idx_huddles_one_live_per_session is load-bearing, not an optimisation: it is
-- what makes two people pressing "Huddle" at the same moment land in ONE room.
CREATE TABLE IF NOT EXISTS huddles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  room_name text NOT NULL UNIQUE,
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_huddles_workspace_id ON huddles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_huddles_session_started ON huddles(session_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_huddles_one_live_per_session ON huddles(session_id) WHERE ended_at IS NULL;

-- APPEND-ONLY. Participant state is folded from this log (foldHuddleState in
-- server/huddles.cjs), never stored denormalised, so the card survives a
-- reconnect and out-of-order webhook delivery with no reconciliation pass.
-- Nothing may UPDATE or DELETE a row here. event_id is LiveKit's own event id;
-- the partial unique index makes a redelivered webhook a no-op.
CREATE TABLE IF NOT EXISTS huddle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  huddle_id uuid NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  identity text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  event_id text NOT NULL DEFAULT '',
  seq bigserial,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_huddle_events_huddle ON huddle_events(huddle_id, created_at, seq);
CREATE INDEX IF NOT EXISTS idx_huddle_events_session ON huddle_events(session_id, created_at, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_huddle_events_event_id ON huddle_events(event_id) WHERE event_id <> '';
