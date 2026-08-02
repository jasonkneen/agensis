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
  background_opacity numeric DEFAULT 0.7,
  background_image text DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  -- Workspace-control bearer verifier. Owner-only routes are the only readers
  -- and writers; generic DB projections deliberately omit both control fields.
  mcp_token_hash text DEFAULT '',
  mcp_auto_approve boolean NOT NULL DEFAULT false,
  -- Groupable workspaces. A workspace with children renders as a group, one
  -- without renders as a leaf; there is no separate folder entity and no new
  -- tier. Children inherit AGENTS and MEMBERS from their ancestors; CONTENT
  -- (channels, documents, tasks, memory) stays isolated to one workspace.
  --
  -- ON DELETE RESTRICT: CASCADE would silently destroy a client's whole
  -- workspace when the agency parent is deleted, and SET NULL would silently
  -- promote it to top level AND strip every member whose access was inherited.
  -- RESTRICT forces the operator to re-parent or delete the children first.
  parent_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  CONSTRAINT workspaces_parent_id_not_self CHECK (parent_id IS NULL OR parent_id <> id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);
CREATE INDEX IF NOT EXISTS idx_workspaces_parent_id ON workspaces(parent_id);

-- The CHECK above rejects the 1-cycle (parent_id = id). Every longer cycle
-- (A -> B -> A and deeper) needs a walk, so it is a trigger. This is enforced
-- at the DB and not only at the API gate because a cycle makes the recursive
-- ancestor walk in the AUTHORIZATION path spin until statement_timeout on every
-- request touching that workspace — one bad row is a denial of service.
CREATE OR REPLACE FUNCTION workspaces_reject_parent_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id uuid := NEW.parent_id;
  steps int := 0;
BEGIN
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'workspace % cannot be its own ancestor', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    steps := steps + 1;
    IF steps > 10 THEN
      RAISE EXCEPTION 'workspace nesting exceeds the maximum depth of 10'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cursor_id FROM workspaces WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspaces_reject_parent_cycle ON workspaces;
CREATE TRIGGER trg_workspaces_reject_parent_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON workspaces
  FOR EACH ROW
  WHEN (NEW.parent_id IS NOT NULL)
  EXECUTE FUNCTION workspaces_reject_parent_cycle();

-- THE WORKSPACE VAULT. One table, three groups: a platform-managed key
-- (ANTHROPIC_API_KEY), `sandbox:<provider>:<credential>` for a provider skill's
-- API key, and anything else as a user-defined shared secret. Classification
-- lives in shared/backend-core.cjs
-- (classifyVaultKey) so both backends agree on what an entry is.
--
-- Deliberately NOT in the backendClient allowlists (ALLOWED_TABLES): the only
-- doors are the dedicated manage-role routes, and none of them returns a value.
-- The read path used by the UI is VAULT_META_SELECT, which does not select the
-- secret columns at all.
CREATE TABLE IF NOT EXISTS workspace_secrets (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  -- Legacy plaintext column. Encrypted rows leave this empty and carry the
  -- AES-256-GCM ciphertext in secret_cipher instead. Rows written before
  -- encryption-at-rest landed still hold plaintext here; they are re-encrypted on
  -- boot by reencryptLegacyPlaintextSecrets (server/index.cjs) rather than by a
  -- migration, because the key is derived in the app from
  -- SECRETS_ENCRYPTION_KEY/AUTH_SECRET and Postgres has no access to it.
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

-- The audit log: a durable, SERVER-AUTHORED record of privileged actions (role
-- changes, member removal, invites, permission-mode flips including 'yolo',
-- permanent tool grants, connect-token mints, vault writes). Deliberately absent
-- from ALLOWED_TABLES in shared/backend-core.cjs, so no generic /backend/db/*
-- route and no realtime subscription can reach it; the only doors are
-- recordAuditEntry and the manage-gated GET /backend/workspaces/:id/audit.
--
-- workspace_id is ON DELETE SET NULL, not CASCADE. Deleting a workspace is the
-- most audit-worthy action there is; CASCADE would erase the evidence of it as a
-- side effect of committing it. Hence the nullable column.
CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id uuid,
  actor_agent_id uuid,
  actor_label text NOT NULL DEFAULT '',
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text,
  target_label text NOT NULL DEFAULT '',
  -- text, not jsonb: these hold short scalars ('editor' -> 'admin') and must not
  -- become the place someone dumps a whole row, and with it a secret.
  before_value text NOT NULL DEFAULT '',
  after_value text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_ip text NOT NULL DEFAULT '',
  -- SHA-256 over the row's canonical content. No prev_hash: a chain would make
  -- every write read the tail under a lock, on paths that must never stall, and
  -- would prove nothing while the only possible anchor is the same database the
  -- operator controls. This detects edits; seq gaps suggest deletion.
  entry_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created ON audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_seq ON audit_log(seq);

-- Append-only at the DB layer. This stops app bugs, a SQL injection reaching a
-- DELETE, and a future contributor allowlisting the table without thinking. It
-- does NOT stop whoever holds DATABASE_URL, who can drop it in one statement --
-- and nothing available in this architecture would.
CREATE OR REPLACE FUNCTION audit_log_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log rows are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  -- DELETE is permitted only past the retention horizon, so pruning never
  -- requires dropping this trigger by hand.
  IF OLD.created_at > now() - interval '400 days' THEN
    RAISE EXCEPTION 'audit_log rows younger than the retention horizon cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_audit_log_refuse_mutation ON audit_log;
CREATE TRIGGER trg_audit_log_refuse_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_refuse_mutation();

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

-- Cross-instance fixed-window counters. This operational table is intentionally
-- outside the generic DB allowlist; only createDbRateLimiter reads or writes it.
-- Mirrors server/index.cjs and 20260718120000_rate_limits.sql.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits(window_start);

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
  description text NOT NULL DEFAULT '',
  icon text NOT NULL DEFAULT '',
  -- How people and AGENTS should behave here, in the owner's own words.
  -- Injected into every agent turn in this channel.
  intent text NOT NULL DEFAULT '',
  is_favorite boolean NOT NULL DEFAULT false,
  participants jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- How eagerly this channel answers a post that named nobody, on ONE axis:
  --   'auto'    someone answers at once (the default, and every existing row)
  --   'social'  someone answers, unhurried — replies are paced seconds apart and
  --             at most two agents answer (shared/replyCadence.cjs)
  --   'mention' nobody answers unless asked
  -- Deliberately UNCONSTRAINED text, normalized in shared/channelMentions.cjs:
  -- an unreadable value reads as 'auto', so a row written by a newer client can
  -- never make a channel go silent. That is why adding 'social' needed no DDL.
  conversation_mode text NOT NULL DEFAULT 'auto',
  max_agent_turns integer NOT NULL DEFAULT 10,
  auto_rounds integer NOT NULL DEFAULT 3,
  parent_message_id uuid,
  split_parent_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL,
  split_at timestamptz,
  -- Server-authored split provenance. The baseline is the one quoted-context
  -- message in the fork; the source boundary is the newest source row visible
  -- in the same locked snapshot. Merge never guesses either from text/time.
  split_baseline_message_id uuid,
  split_source_boundary_message_id uuid,
  archived_at timestamptz,
  deleted_at timestamptz,
  canvas_id text,
  version integer NOT NULL DEFAULT 1,
  -- Who may READ this session, one level BELOW the workspace role check:
  --   'workspace'  every member with `read` — channels, and the default
  --   'private'    only rows in chat_session_members (plus a manage-granted one)
  -- DMs and everything derived from a DM (sub-thread splits, huddle transcripts)
  -- are 'private'. Deliberately a text column and not a boolean: the next
  -- visibility we need is a private CHANNEL, not a second flag.
  --
  -- Read as private ONLY on an exact 'private' match — but the authorizer also
  -- treats folder='Direct messages' as private regardless, so a new DM-creating
  -- path that forgets to set this column cannot open a hole. Fail closed.
  visibility text NOT NULL DEFAULT 'workspace',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_sessions_workspace_id ON chat_sessions(workspace_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_folder ON chat_sessions(workspace_id, folder);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_archived ON chat_sessions(workspace_id, archived_at);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_favorite ON chat_sessions(workspace_id, is_favorite);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_canvas ON chat_sessions(workspace_id, canvas_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_visibility ON chat_sessions(workspace_id, visibility);

-- Who may read a `visibility='private'` session. Empty for every 'workspace'
-- session — this table is consulted ONLY after the session is known private, so
-- channels cost nothing.
--
-- DELIBERATELY ABSENT FROM ALLOWED_TABLES in shared/backend-core.cjs, for the
-- same reason audit_log is: reachable through POST /backend/db/insert, this
-- table IS a self-grant primitive and the whole feature becomes theatre. The
-- only doors are the participant writes on the DM-creation paths and the
-- manage-gated grant/revoke routes. tests/dm-read-scope fails if anyone
-- allowlists it.
CREATE TABLE IF NOT EXISTS chat_session_members (
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  -- 'participant' — intrinsic: opened this DM, or dispatched an agent into it.
  -- 'grant'       — explicitly given by a member holding `manage`, and audited.
  -- The distinction is what makes a revoke safe: revoking clears grants and
  -- must never strip the person whose DM it is.
  source text NOT NULL DEFAULT 'participant',
  granted_by uuid,
  -- NULL = open-ended. A past timestamp reads as no access at all; expiry is
  -- evaluated in SQL so an expired row cannot be honoured by a stale cache.
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_session_members_user ON chat_session_members(user_id);

-- message_kind/tool_name/tool_detail carry agent tool steps: message_kind
-- 'tool_step' marks a row the UI renders as a compact chip rather than a full
-- chat bubble, and the two tool_* halves are the structured form of the
-- human-readable `content` line, which stays populated as the fallback. All
-- three default to '' so every pre-existing row stays valid.
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
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
-- Attachment REFERENCES: [{id, name, type, size}] pointing at uploaded_files
-- rows, for rendering (image inline, anything else as a download chip). Never
-- file bytes. Mirrors the runtime ALTER in server/index.cjs.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]';
CREATE INDEX IF NOT EXISTS idx_messages_pinned ON messages(session_id, pinned);
CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(session_id, deleted_at);

-- A closed conversation is a storage boundary shared by every message writer.
-- INSERT locks the live session against the clear route; UPDATE cannot move a
-- message or modify a tombstone. Mirrors ensureRuntimeSchema and the dedicated
-- migration.
CREATE OR REPLACE FUNCTION messages_require_live_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
      RAISE EXCEPTION 'A message cannot move between conversations'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'messages_live_session_write_guard';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'A deleted message is immutable'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'messages_live_session_write_guard';
    END IF;
    PERFORM 1
      FROM chat_sessions
     WHERE id = NEW.session_id
       AND deleted_at IS NULL;
  ELSE
    PERFORM 1
      FROM chat_sessions
     WHERE id = NEW.session_id
       AND deleted_at IS NULL
     FOR SHARE;
    -- Stamp after the live-session lock is acquired. A message INSERT waiting
    -- behind an atomic split/close must sort after that boundary even when its
    -- transaction began earlier (now() would preserve the stale start time).
    IF FOUND THEN
      NEW.created_at = clock_timestamp();
    END IF;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Messages require a live conversation'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'messages_live_session_write_guard';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_require_live_session ON messages;
CREATE TRIGGER trg_messages_require_live_session
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_require_live_session();

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
-- taskThreadLastWordAt (server/task-dispatch.cjs) filters `root.source_task_id`
-- with no session_id, so it cannot use the (session_id, source_task_id) index
-- above — Postgres has no index skip scan. Partial on both predicates because
-- that query always pairs source_task_id with `thread_parent_id is null`, and
-- only thread ROOTS carry source_task_id: 23 of 5493 message rows, a 16 kB index.
-- Keep the composite index above too: postTaskSubthreadMention queries on both
-- columns and does use it.
CREATE INDEX IF NOT EXISTS idx_messages_source_task_root
  ON messages(source_task_id)
  WHERE source_task_id IS NOT NULL AND thread_parent_id IS NULL;

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

-- Workspace automations: "when X happens inside agensis, do Y inside agensis",
-- without a code change. Engine: server/automations.cjs. Evaluator (pure):
-- shared/automation-rules.cjs.
--
-- Distinct from flow_connections directly above, and deliberately a different
-- word: a flow connection is OUTBOUND (a workspace event POSTed to an external
-- URL for the Flows product). An automation is INTERNAL -- it ends in a write
-- back into this workspace, decided by a deterministic evaluator with no model
-- call. They share the event vocabulary and nothing else.
CREATE TABLE IF NOT EXISTS automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  -- OFF by default: a definition that starts live means a mistyped condition
  -- fires on everything before the author has read it back.
  enabled boolean NOT NULL DEFAULT false,
  -- Denormalised out of definition so the matcher is a partial-index lookup
  -- rather than a jsonb scan on every workspace write.
  trigger_event text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  run_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_status text NOT NULL DEFAULT '',
  -- Set by the runaway guard; a tripped automation stays off until a human
  -- clears it, and this is why the UI can say why it stopped.
  disabled_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(workspace_id, trigger_event) WHERE enabled;

-- One row per (automation, triggering event). The queue AND the history.
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_expires_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotent enqueue. This index IS the deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_event ON automation_runs(automation_id, event_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_pending ON automation_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace ON automation_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_recent ON automation_runs(automation_id, created_at DESC);

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

-- Suggestions ("Harvested" as the table was originally named). Same omission as
-- thread_items above: this existed ONLY in the runtime DDL, so a fresh migrate
-- DB never got it. Placed after chat_sessions and workspaces because it FKs
-- both, and psql runs this file top to bottom with ON_ERROR_STOP=1.
--
-- Proposals mined from a conversation — see server/thread-harvest.cjs for why
-- they are proposals and never direct writes into memory_facts/documents, and
-- why the table keeps this name while the product says "Suggestions".
CREATE TABLE IF NOT EXISTS thread_harvests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  reason text NOT NULL DEFAULT 'deleted',
  requested_by uuid,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  -- The watermark: the newest message a COMPLETED analysis has already read, so
  -- a long conversation is never re-analysed from message 1. Null means "read
  -- from the start".
  cursor_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_thread_harvests_pending ON thread_harvests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_thread_harvests_workspace ON thread_harvests(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_thread_harvests_session ON thread_harvests(session_id, updated_at DESC);
-- One OPEN suggestion job per conversation: a double delete, or a race between
-- two server processes on the idle sweep, must cost one row rather than two
-- model calls.
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_harvests_one_open
  ON thread_harvests(session_id) WHERE status IN ('pending', 'running');

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
  -- Runtime/host configuration. metadata is manage-only because host_folders
  -- becomes a daemon --add-dir argument.
  metadata jsonb DEFAULT '{}'::jsonb,
  -- Descriptive intent only. These fields grant no tools, permissions, host
  -- folders, runtime placement or other authority.
  purpose text NOT NULL DEFAULT 'collaborator'
    CHECK (purpose IN ('collaborator', 'resource')),
  resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(resource_facets) = 'array'
      AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    ),
  -- How the agent presents itself, and who chose each part:
  --   { voice: { locale, variant, rate, pitch }, human_set: { name: true, ... } }
  -- `voice` stores a PREFERENCE (accent + a variant index + rate/pitch), never a
  -- device voice name — getVoices() returns a different list on every machine.
  -- `human_set` records which fields a person chose, so an agent's identity
  -- declaration on reconnect can default the rest without overwriting them.
  -- Separate from `metadata` because metadata is manage-only (host_folders).
  identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  handle text DEFAULT '',
  connect_token_hash text DEFAULT '',
  model text NOT NULL DEFAULT 'auto',
  run_mode text NOT NULL DEFAULT 'builtin',
  sandbox_provider text,
  sandbox_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  memory_dir text DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  -- May this agent be drawn into a channel post that named nobody?
  -- DEFAULT true because unprompted replies already ship for every 'auto'
  -- channel; defaulting to false would silently silence every existing agent.
  -- Explicit addressing (@mention, @channel, DM, thread reply) ignores this
  -- column entirely — see shared/ambientAddressing.cjs.
  ambient_replies boolean NOT NULL DEFAULT true,
  permission_mode text NOT NULL DEFAULT 'default',
  mcp_approved boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT workspace_agents_resource_facets_match_purpose CHECK (
    (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
    OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
  )
);

CREATE INDEX IF NOT EXISTS idx_workspace_agents_workspace_id ON workspace_agents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_agents_handle ON workspace_agents(workspace_id, handle);
CREATE INDEX IF NOT EXISTS idx_workspace_agents_connect_token_hash ON workspace_agents(connect_token_hash);

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

-- Agent skill documents: the BODY behind a skill name a daemon advertises.
-- `agent_connections.capabilities.skills` carries names only, so the Skills
-- browser had nothing to show for them; a daemon mirrors the real SKILL.md here
-- via the `agent_skill_sync` push (same shape as the memory mirror above).
-- Read-only in-app — the daemon is the only writer, and the browser reads it
-- through /backend/system/skill-content, not the generic table API.
CREATE TABLE IF NOT EXISTS agent_skill_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  skill text NOT NULL,
  path text DEFAULT '',
  summary text DEFAULT '',
  content text DEFAULT '',
  byte_size bigint DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  last_synced timestamptz DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (agent_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_documents_workspace_id ON agent_skill_documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_skill_documents_agent_id ON agent_skill_documents(agent_id);

-- Agent templates ("persona packs") as DATA rather than code. Validator:
-- shared/agentTemplates.cjs. Routes: server/agent-templates-routes.cjs.
--
-- THE ABSENT COLUMNS ARE THE SECURITY CONTROL. There is deliberately no
-- permission_mode, metadata, sandbox_provider, sandbox_config,
-- connect_token_hash, mcp_approved, memory_dir or identity. A template carries
-- prose, requests and descriptive intent; it never carries authority, and you
-- cannot import what the shape cannot hold. metadata is the field that looks
-- harmless and is not:
-- it holds host_folders (which the daemon turns into `--add-dir <path>` on a
-- real machine) and sandbox_skills (a baseUrl the server fetches plus a vault
-- credential key). Adding any of them later is a security decision.
CREATE TABLE IF NOT EXISTS workspace_agent_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'Custom',
  description text DEFAULT '',
  handle_hint text DEFAULT '',
  system_prompt text DEFAULT '',
  soul text DEFAULT '',
  instructions text DEFAULT '',
  -- Both string[]. skills MUST stay string[] — the Agents window round-trips it
  -- through a comma-separated text input, so an object renders '[object Object]'
  -- and is saved back over the real definition on the next edit.
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Safe template intent, not authority. Instantiation still uses the existing
  -- generic agent creation path and its permission guards.
  purpose text NOT NULL DEFAULT 'collaborator'
    CHECK (purpose IN ('collaborator', 'resource')),
  resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(resource_facets) = 'array'
      AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    ),
  model text NOT NULL DEFAULT 'auto',
  run_mode text NOT NULL DEFAULT 'builtin',
  runtime text DEFAULT '',
  avatar text DEFAULT '',
  accent_color text DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'authored',
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT workspace_agent_templates_resource_facets_match_purpose CHECK (
    (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
    OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
  ),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_templates_workspace_id
  ON workspace_agent_templates(workspace_id);

-- WORKSPACE-AUTHORED SKILLS. The app-side skill store.
--
-- agent_skill_documents (above) is daemon-owned: written by an agent_skill_sync
-- push, keyed per agent, read-only in-app and absent from ALLOWED_TABLES. This
-- table is the writable, workspace-scoped half. Sync direction is UNCHANGED --
-- skills still flow UP from daemons; nothing here is written down onto anyone's
-- disk. Agents read these bodies at turn time through the `read_skill` MCP tool,
-- which fences them as untrusted data.
--
-- THE ABSENT COLUMNS ARE THE SECURITY CONTROL: no base_url, no credential, no
-- endpoints, no mcp, no code, no path, no agent_id, no tools, no
-- permission_mode. A workspace skill carries PROSE and never AUTHORITY. The
-- privilege-bearing skill shape lives in workspace_agents.metadata.sandbox_skills,
-- which is MANAGE_ONLY. See shared/workspaceSkills.cjs.
CREATE TABLE IF NOT EXISTS workspace_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL,
  summary text DEFAULT '',
  body text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'authored',
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_skills_workspace_id
  ON workspace_skills(workspace_id);

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

-- The ONE join link: a single short-lived, single-use URL that a human OR an
-- agent can redeem. Redeeming provisions the real credential server-side; the
-- link itself is never a credential and appears in no auth path.
--
-- Separate from workspace_invites on purpose: that table is the legacy,
-- email-oriented human invitation record and lives for 14 days. Neither table
-- is accepted as an MCP bearer. A join link lives minutes, works once, and can
-- authenticate nothing outside its dedicated redemption route.
CREATE TABLE IF NOT EXISTS workspace_join_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
  grant_kind text NOT NULL DEFAULT 'individual' CHECK (grant_kind IN ('individual', 'workspace_control')),
  audience text NOT NULL DEFAULT 'both' CHECK (audience IN ('both', 'human', 'agent', 'controller')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'revoked')),
  redeemed_as text NOT NULL DEFAULT '' CHECK (redeemed_as IN ('', 'human', 'agent', 'controller')),
  redeemed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  redeemed_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  redeemed_controller_id uuid,
  controller_name text NOT NULL DEFAULT '',
  controller_scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  controller_expires_at timestamptz,
  redeemed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT workspace_join_links_controller_shape_check CHECK (
    (
      grant_kind = 'individual'
      AND audience IN ('both', 'human', 'agent')
      AND controller_name = ''
      AND controller_scopes = '[]'::jsonb
      AND controller_expires_at IS NULL
    )
    OR
    (
      grant_kind = 'workspace_control'
      AND audience = 'controller'
      AND btrim(controller_name) <> ''
      AND jsonb_typeof(controller_scopes) = 'array'
      AND jsonb_array_length(controller_scopes) > 0
      AND controller_scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
      AND controller_expires_at IS NOT NULL
    )
  )
);

ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS grant_kind text NOT NULL DEFAULT 'individual';
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_name text NOT NULL DEFAULT '';
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_expires_at timestamptz;
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS redeemed_controller_id uuid;
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_grant_kind_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_grant_kind_check
  CHECK (grant_kind IN ('individual', 'workspace_control'));
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_audience_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_audience_check
  CHECK (audience IN ('both', 'human', 'agent', 'controller'));
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_redeemed_as_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_redeemed_as_check
  CHECK (redeemed_as IN ('', 'human', 'agent', 'controller'));
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_controller_shape_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_controller_shape_check CHECK (
    (
      grant_kind = 'individual'
      AND audience IN ('both', 'human', 'agent')
      AND controller_name = ''
      AND controller_scopes = '[]'::jsonb
      AND controller_expires_at IS NULL
    )
    OR
    (
      grant_kind = 'workspace_control'
      AND audience = 'controller'
      AND btrim(controller_name) <> ''
      AND jsonb_typeof(controller_scopes) = 'array'
      AND jsonb_array_length(controller_scopes) > 0
      AND controller_scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
      AND controller_expires_at IS NOT NULL
    )
  );

CREATE INDEX IF NOT EXISTS idx_workspace_join_links_workspace_id ON workspace_join_links(workspace_id, created_at DESC);

-- Named, individually revocable workspace-control credentials. These are not
-- workspace members and are deliberately absent from ALLOWED_TABLES: their
-- only surfaces are dedicated owner routes and explicitly controller-aware MCP
-- tools. The scope shape cannot express role grants, raw vault reads, generic
-- message posting, or private-session reads.
CREATE TABLE IF NOT EXISTS workspace_controllers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(scopes) = 'array'
    AND jsonb_array_length(scopes) > 0
    AND scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  parent_controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workspace_controllers_workspace
  ON workspace_controllers(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_controllers_parent
  ON workspace_controllers(parent_controller_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_join_links_redeemed_controller_id_fkey'
  ) THEN
    ALTER TABLE workspace_join_links
      ADD CONSTRAINT workspace_join_links_redeemed_controller_id_fkey
      FOREIGN KEY (redeemed_controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
  END IF;
END $$;

-- Every agent enrolled by a controller carries that lineage. This is
-- attribution, not authority: changing controller_id does not change the
-- agent's model, permission mode, token, tools, host folders, or session access.
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS controller_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_agents_controller_id_fkey'
  ) THEN
    ALTER TABLE workspace_agents
      ADD CONSTRAINT workspace_agents_controller_id_fkey
      FOREIGN KEY (controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_workspace_agents_controller_id ON workspace_agents(controller_id);

-- Shared resources remain agent-gated. Nothing here is generically selectable
-- or subscribable; callers ask for a structured operation and the steward agent
-- on its own host claims and settles it.
CREATE TABLE IF NOT EXISTS workspace_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  steward_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE RESTRICT,
  controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  facet text NOT NULL CHECK (facet IN ('context', 'knowledge', 'tooling', 'code')),
  descriptor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(descriptor) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'restricted')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  deleted_at timestamptz,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_resources_workspace
  ON workspace_resources(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_resources_deleted
  ON workspace_resources(workspace_id, deleted_at, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_resources_steward
  ON workspace_resources(steward_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_workspace_resources_controller
  ON workspace_resources(controller_id);

CREATE TABLE IF NOT EXISTS resource_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES workspace_resources(id) ON DELETE CASCADE,
  steward_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE RESTRICT,
  requested_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  requested_by_agent_id uuid REFERENCES workspace_agents(id) ON DELETE RESTRICT,
  requested_by_controller_id uuid REFERENCES workspace_controllers(id) ON DELETE RESTRICT,
  requested_by_workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  requester_key text NOT NULL,
  claimed_by_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (operation IN ('read', 'propose', 'apply', 'publish')),
  input_artifact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_artifact) = 'object'),
  output_artifact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_artifact) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'rejected', 'failed', 'cancelled')),
  resource_version integer NOT NULL CHECK (resource_version > 0),
  idempotency_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_expires_at timestamptz,
  error text NOT NULL DEFAULT '',
  progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  progress_seq bigint NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
  progress_updated_at timestamptz,
  audit_reference uuid REFERENCES audit_log(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT resource_operations_one_requester_check CHECK (
    num_nonnulls(requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id) = 1
  ),
  UNIQUE (workspace_id, requester_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_resource_operations_resource
  ON resource_operations(resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resource_operations_claim
  ON resource_operations(steward_agent_id, status, created_at);
-- Controller ids are attribution, not authority, but they must never point
-- across tenants. The single-column FKs above cannot express that.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_controllers_id_workspace_key') THEN
    ALTER TABLE workspace_controllers ADD CONSTRAINT workspace_controllers_id_workspace_key UNIQUE (id, workspace_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_controllers_parent_workspace_fkey'
      AND confdeltype = 'n' AND confdelsetcols IS NULL
  ) THEN
    ALTER TABLE workspace_controllers DROP CONSTRAINT workspace_controllers_parent_workspace_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_controllers_parent_workspace_fkey') THEN
    ALTER TABLE workspace_controllers ADD CONSTRAINT workspace_controllers_parent_workspace_fkey
      FOREIGN KEY (parent_controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (parent_controller_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_agents_controller_workspace_fkey'
      AND confdeltype = 'n' AND confdelsetcols IS NULL
  ) THEN
    ALTER TABLE workspace_agents DROP CONSTRAINT workspace_agents_controller_workspace_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_agents_controller_workspace_fkey') THEN
    ALTER TABLE workspace_agents ADD CONSTRAINT workspace_agents_controller_workspace_fkey
      FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_resources_controller_workspace_fkey'
      AND confdeltype = 'n' AND confdelsetcols IS NULL
  ) THEN
    ALTER TABLE workspace_resources DROP CONSTRAINT workspace_resources_controller_workspace_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_resources_controller_workspace_fkey') THEN
    ALTER TABLE workspace_resources ADD CONSTRAINT workspace_resources_controller_workspace_fkey
      FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_join_links_redeemed_controller_workspace_fkey'
      AND confdeltype = 'n' AND confdelsetcols IS NULL
  ) THEN
    ALTER TABLE workspace_join_links DROP CONSTRAINT workspace_join_links_redeemed_controller_workspace_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_join_links_redeemed_controller_workspace_fkey') THEN
    ALTER TABLE workspace_join_links ADD CONSTRAINT workspace_join_links_redeemed_controller_workspace_fkey
      FOREIGN KEY (redeemed_controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (redeemed_controller_id);
  END IF;
END $$;

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
  background_opacity double precision DEFAULT 0.7,
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
-- References to uploaded_files rows, same shape as messages.attachments — see
-- JSON_COLUMNS_BY_TABLE / lib/messageAttachments.ts.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
-- Server-owned identity of the human whose per-human agent DM should receive a
-- queued assignment. This is deliberately separate from created_by: a task can
-- be created by one person and assigned by another.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS dispatch_requested_by uuid;

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
  controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
  requested_handle text DEFAULT '',
  requested_name text DEFAULT '',
  -- Identity declared in register_agent. Approval is asynchronous, so this has
  -- to outlive the pending state or a new agent loses the avatar/voice it asked
  -- for at the moment its workspace_agents row is created.
  requested_identity jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_purpose text NOT NULL DEFAULT 'collaborator'
    CHECK (requested_purpose IN ('collaborator', 'resource')),
  requested_resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(requested_resource_facets) = 'array'
      AND requested_resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    ),
  client_label text DEFAULT '',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  decided_at timestamptz,
  CONSTRAINT agent_registrations_resource_facets_match_purpose CHECK (
    (requested_purpose = 'collaborator' AND requested_resource_facets = '[]'::jsonb)
    OR (requested_purpose = 'resource' AND jsonb_array_length(requested_resource_facets) > 0)
  )
);
ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS controller_id uuid;
ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_purpose text NOT NULL DEFAULT 'collaborator';
ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_requested_purpose_check;
ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_requested_purpose_check
  CHECK (requested_purpose IN ('collaborator', 'resource'));
ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_requested_resource_facets_check;
ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_requested_resource_facets_check CHECK (
  jsonb_typeof(requested_resource_facets) = 'array'
  AND requested_resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
);
ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_resource_facets_match_purpose;
ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_resource_facets_match_purpose CHECK (
  (requested_purpose = 'collaborator' AND requested_resource_facets = '[]'::jsonb)
  OR (requested_purpose = 'resource' AND jsonb_array_length(requested_resource_facets) > 0)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_registrations_controller_id_fkey'
  ) THEN
    ALTER TABLE agent_registrations
      ADD CONSTRAINT agent_registrations_controller_id_fkey
      FOREIGN KEY (controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_agent_registrations_workspace ON agent_registrations(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_agent_registrations_controller ON agent_registrations(controller_id, status);
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_registrations_controller_workspace_fkey'
      AND confdeltype = 'n' AND confdelsetcols IS NULL
  ) THEN
    ALTER TABLE agent_registrations DROP CONSTRAINT agent_registrations_controller_workspace_fkey;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_registrations_controller_workspace_fkey') THEN
    ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_controller_workspace_fkey
      FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
  END IF;
END $$;

-- Link preview (unfurl) cache. Keyed by a hash of the normalized URL and
-- deliberately NOT workspace-scoped: one outbound fetch per URL for the whole
-- install, rather than one per workspace, per reader, per render. Nothing in a
-- row is private — it is metadata a public page publishes about itself.
--
-- Absent from ALLOWED_TABLES on purpose, so it cannot be reached (or enumerated)
-- through the generic /backend/db gate. Read only by POST /backend/link-previews.
-- Mirrors the runtime bootstrap in server/index.cjs and
-- supabase/migrations/20260726190000_link_previews.sql.
CREATE TABLE IF NOT EXISTS link_previews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  url_hash text NOT NULL UNIQUE,
  url text NOT NULL,
  final_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ok'
    CHECK (status IN ('ok', 'empty', 'failed', 'blocked')),
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  site_name text NOT NULL DEFAULT '',
  image_url text NOT NULL DEFAULT '',
  detail text NOT NULL DEFAULT '',
  fetched_at timestamptz NOT NULL DEFAULT now(),
  -- ok/empty rows last a week, failures an hour (see linkPreviewTtlMs).
  expires_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_link_previews_expires ON link_previews(expires_at);

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

CREATE TABLE IF NOT EXISTS nostr_community_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  relay_http_url text NOT NULL,
  relay_ws_url text NOT NULL,
  community_id text NOT NULL DEFAULT '',
  host text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT 'Nostr community',
  description text NOT NULL DEFAULT '',
  relay_pubkey text NOT NULL DEFAULT '',
  member_pubkey text NOT NULL DEFAULT '',
  policy_version text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  last_event_at bigint NOT NULL DEFAULT 0,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, relay_ws_url)
);
CREATE INDEX IF NOT EXISTS idx_nostr_community_connections_workspace
  ON nostr_community_connections(workspace_id);

CREATE TABLE IF NOT EXISTS nostr_community_members (
  connection_id uuid NOT NULL REFERENCES nostr_community_connections(id) ON DELETE CASCADE,
  channel_id text NOT NULL,
  pubkey text NOT NULL,
  name text NOT NULL DEFAULT '',
  handle text NOT NULL DEFAULT '',
  picture text NOT NULL DEFAULT '',
  is_agent boolean NOT NULL DEFAULT false,
  aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (connection_id, channel_id, pubkey)
);
CREATE INDEX IF NOT EXISTS idx_nostr_community_members_lookup
  ON nostr_community_members(connection_id, channel_id, lower(handle));

-- External-network bridge definitions. The agent/desktop daemon remains the
-- gatekeeper for device-bound providers; hub providers are carried by Fly.
-- These definitions mirror ensureRuntimeSchema and the forward migration.
CREATE TABLE IF NOT EXISTS channel_bridges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('telegram', 'slack', 'whatsapp', 'signal', 'openclaw', 'nostr')),
  lane text NOT NULL CHECK (lane IN ('hub', 'daemon')),
  external_id text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  nostr_connection_id uuid REFERENCES nostr_community_connections(id) ON DELETE CASCADE,
  nostr_last_event_at bigint NOT NULL DEFAULT 0,
  nostr_initial_sync_completed boolean NOT NULL DEFAULT false,
  connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  last_error text,
  last_inbound_at timestamptz,
  last_outbound_at timestamptz,
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_channel_bridges_workspace_id ON channel_bridges(workspace_id);
CREATE INDEX IF NOT EXISTS idx_channel_bridges_session_id ON channel_bridges(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bridges_session ON channel_bridges(session_id);
CREATE INDEX IF NOT EXISTS idx_channel_bridges_nostr_connection ON channel_bridges(nostr_connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bridges_nostr_channel
  ON channel_bridges(nostr_connection_id, external_id)
  WHERE nostr_connection_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS bridge_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bridge_id uuid NOT NULL REFERENCES channel_bridges(id) ON DELETE CASCADE,
  external_message_id text NOT NULL,
  direction text NOT NULL,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_bridge_messages_external
  ON bridge_messages(bridge_id, external_message_id);
CREATE INDEX IF NOT EXISTS idx_bridge_messages_message_id ON bridge_messages(message_id);

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

CREATE TABLE IF NOT EXISTS cursorbuddy_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  site_url text NOT NULL,
  host text NOT NULL,
  path_pattern text NOT NULL DEFAULT '/*',
  name text NOT NULL,
  summary text NOT NULL DEFAULT '',
  manifest jsonb NOT NULL DEFAULT '{}'::jsonb,
  review_status text NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft', 'pending', 'approved', 'rejected')),
  review_notes text NOT NULL DEFAULT '',
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  published_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cursorbuddy_guides_owner ON cursorbuddy_guides(owner_user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_cursorbuddy_guides_public_match ON cursorbuddy_guides(host, review_status, published_at DESC);

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
-- Match the forward migration/runtime repair before adding the partial UNIQUE
-- index, so pushing this canonical file over an older database cannot fail on
-- message-activity duplicates that predate idempotent logging.
DELETE FROM activity_events a
USING activity_events b
WHERE a.event_type = 'message_sent'
  AND a.entity_type = 'message'
  AND b.event_type = 'message_sent'
  AND b.entity_type = 'message'
  AND a.entity_id IS NOT NULL
  AND a.entity_id = b.entity_id
  AND a.ctid > b.ctid;
CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_events_message_sent
  ON activity_events (entity_id)
  WHERE event_type = 'message_sent' AND entity_type = 'message';

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

-- Read receipts: one MONOTONIC high-water mark per (session, user) — "I had this
-- conversation on screen up to this point". Mirrors ensureRuntimeSchema in
-- server/index.cjs, which runs the DDL single-sourced in shared/read-receipts.cjs.
--
-- NOT a row per message per user. That model is 4,000,000 rows at 20 users x
-- 200k messages, grows with every message sent times the workspace size, and is
-- written on every scroll. This one is bounded by (members x sessions) — about
-- 1,200 rows for the same workspace — and a page of scrolling coalesces into a
-- single write because the marker IS the coalescing. It is also the more private
-- model: it can say "up to this point" and cannot say "they read that one and
-- skipped the next", because that is never recorded.
--
-- NO workspace_id COLUMN, ON PURPOSE. It mirrors `messages`: with no workspace
-- column an unscoped subscription cannot be EXPRESSED, so a client must filter by
-- session_id, resolveOperationWorkspace resolves the tenant through chat_sessions
-- and enforceDbOperationAccess then runs the DM gate for that session. That makes
-- "a non-member cannot see who read a private conversation" a property of the
-- schema rather than of a query remembering to say so.
--
-- session_id leads the unique indexes because the normal read is "all markers
-- for THIS session". Opt-out is the deliberate reverse lookup: delete every
-- marker for one human, so user_id also has a partial lookup index.
-- A reader is EITHER a human (user_id -> app_users) or an agent (agent_id ->
-- workspace_agents). "Has this agent seen it" is a first-class receipt, so the
-- table carries both nullable FKs, a CHECK that exactly one is set, and a partial
-- unique index per kind in place of the old (session_id, user_id) primary key.
CREATE TABLE IF NOT EXISTS session_read_state (
  marker_id uuid NOT NULL DEFAULT gen_random_uuid(),
  event_version bigint GENERATED BY DEFAULT AS IDENTITY,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
  thread_parent_id uuid REFERENCES messages(id) ON DELETE CASCADE,
  last_seen_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT session_read_state_marker_id_key UNIQUE (marker_id),
  CONSTRAINT session_read_state_one_reader CHECK ((user_id IS NOT NULL) <> (agent_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_user_scope_uidx
  ON session_read_state (session_id, user_id, thread_parent_id) NULLS NOT DISTINCT
  WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_agent_scope_uidx
  ON session_read_state (session_id, agent_id, thread_parent_id) NULLS NOT DISTINCT
  WHERE agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_read_state_user_lookup_idx
  ON session_read_state (user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS session_read_state_agent_lookup_idx
  ON session_read_state (agent_id) WHERE agent_id IS NOT NULL;

-- The receipts opt-out, and it is RECIPROCAL: switching it off stops your
-- markers being written AND stops you seeing anyone else's (both halves are in
-- the SQL in shared/read-receipts.cjs, not in the UI). Reciprocity is what keeps
-- the setting from being a one-way mirror. Defaults to true — an opt-out that
-- starts switched off is a feature nobody ever sees.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS share_read_receipts boolean NOT NULL DEFAULT true;

-- Owner broadcasts (shared/tenant-campaigns.cjs). The only rows here addressed
-- to ACCOUNTS rather than scoped to a workspace, which is why neither table is
-- in the backendClient allowlists — the dedicated owner-gated routes are the
-- only door. Mirrors ensureRuntimeSchema in server/index.cjs.
--
-- The campaign row IS the audit trail: who sent it (created_by, plus the email
-- as it read at send time so a later rename cannot rewrite history), what it
-- said, the segment and its plain-English summary, and how many accounts it
-- reached.
CREATE TABLE IF NOT EXISTS tenant_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  surface text NOT NULL DEFAULT 'tip',
  segment jsonb NOT NULL DEFAULT '{}'::jsonb,
  segment_summary text NOT NULL DEFAULT '',
  recipient_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_by_email text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_campaigns_created_at ON tenant_campaigns(created_at DESC);

-- The FROZEN audience, written once at send time, and the per-user dismissal
-- record. Both jobs in one table on purpose: a user can only dismiss a message
-- that was actually sent to them, because the row they update is the row that
-- made them a recipient. Server-side rather than a localStorage key so a
-- dismissal survives a different browser and two accounts sharing one browser
-- never share one dismissal. The composite PK is the delivery index.
CREATE TABLE IF NOT EXISTS tenant_campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES tenant_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  dismissed_at timestamptz,
  PRIMARY KEY (user_id, campaign_id)
);
CREATE INDEX IF NOT EXISTS idx_tenant_campaign_recipients_campaign
  ON tenant_campaign_recipients(campaign_id);

-- Durable queue for work delivered to connected agents. This table used to
-- exist only in ensureRuntimeSchema, so a fresh database created with
-- `npm run db:neon:push` had schedules and sessions but no queue for the work
-- they dispatched. Keep this definition byte-for-byte compatible with the
-- runtime bootstrap in server/index.cjs.
CREATE TABLE IF NOT EXISTS agent_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  connection_id uuid REFERENCES agent_connections(id) ON DELETE SET NULL,
  session_id uuid REFERENCES chat_sessions(id) ON DELETE CASCADE,
  message_id uuid REFERENCES messages(id) ON DELETE SET NULL,
  created_by uuid,
  prompt text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'done', 'error', 'cancelled')),
  response text DEFAULT '',
  error text DEFAULT '',
  metadata jsonb DEFAULT '{}'::jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_workspace_id ON agent_jobs(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_agent_id ON agent_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_jobs_session_id ON agent_jobs(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_active_per_session_agent
  ON agent_jobs(session_id, agent_id)
  WHERE status IN ('queued', 'running');

-- Scheduled agent runs. A schedule posts a prompt into a session on a cadence
-- (interval_seconds) and lets the orchestrator dispatch. Mirrors the runtime
-- bootstrap DDL in server/index.cjs so a fresh neon-push has the tables too.
CREATE TABLE IF NOT EXISTS agent_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
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
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ok',
  detail text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule ON agent_schedule_runs(schedule_id, created_at desc);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_session ON agent_schedule_runs(session_id, created_at desc);
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
--
-- TWO session links, meaning different things. session_id is the channel/DM the
-- huddle was CALLED FROM. transcript_session_id is the huddle's OWN
-- conversation — its own chat_sessions row (folder='huddle', participants and
-- canvas_id copied from the host) where speech-to-text and the agents' replies
-- land, so a live voice call is not dumped into the channel's permanent
-- history. Nullable: huddles predating it have none, and every reader falls
-- back to session_id, which is what those huddles actually did.
CREATE TABLE IF NOT EXISTS huddles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  room_name text NOT NULL UNIQUE,
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz,
  transcript_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL
);
ALTER TABLE huddles ADD COLUMN IF NOT EXISTS transcript_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;
-- Shared call notes (the dock's Notes tab). Written only through
-- POST /backend/workspaces/:id/huddles/:huddleId/notes — see server/huddles.cjs.
ALTER TABLE huddles ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';
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

-- Liveness, and the ONE mutable table in the huddle surface.
--
-- A browser that crashes, loses power or is force-quit never posts its /leave,
-- so presence has to EXPIRE rather than be deleted: a connected client refreshes
-- last_seen_at/heartbeat_at every 30s and the server reaps anything that has
-- gone quiet for 150s (2.5x the worst-case one-wake-per-minute clamp browsers
-- apply to hidden tabs, so a backgrounded participant is never kicked out of a
-- call they are still in).
--
-- Not part of huddle_events on purpose. That log is history and is never
-- updated; "is this person still there" is a current value, and appending a row
-- per participant per heartbeat would grow without bound for no gain.
--
-- heartbeat_at is NULL until the client's first beat, and the reaper keys on it
-- ALONE: a client that confirms but never beats (an older frontend — Netlify and
-- Fly deploy independently) is never expired, so the reaper cannot empty live
-- huddles in the gap between the two deploys.
CREATE TABLE IF NOT EXISTS huddle_presence (
  huddle_id uuid NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  identity text NOT NULL,
  connection_epoch text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  reaped_at timestamptz,
  PRIMARY KEY (huddle_id, identity)
);

-- The channel marker: ONE message per finished huddle, in the channel it was
-- called from, saying it happened and pointing back at the transcript.
-- Deliberately no foreign key — messages is created hundreds of lines above
-- huddles, and a dangling huddle_id degrades to a plain sentence with a dead
-- link, which is the same graceful path an old huddle with no transcript
-- session already takes.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS huddle_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_huddle ON messages(huddle_id) WHERE huddle_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- In-app feedback -> the System workspace.
--
-- A feedback report is an ORDINARY task in an ORDINARY workspace: the only new
-- concept is `workspaces.is_system`, a flag on one workspace that the app
-- routes reports into. Members, roles, invites, assignment and agent dispatch
-- all work on it unchanged, and there is no second todo system to keep in sync.
--
-- The PARTIAL unique index is what makes "the System workspace" singular, and
-- what makes ensureSystemWorkspace (shared/backend-core.cjs) race-safe: two
-- concurrent first-ever submissions cannot create two of them.
-- ---------------------------------------------------------------------------
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_system ON workspaces (is_system) WHERE is_system;

-- 'feedback' and 'automation' provenance. Dropped and re-added because Postgres
-- has no ALTER for a CHECK constraint; the name is deterministic (matching the
-- inline column check above), so re-running this file is idempotent.
--
-- Widening is safe on a populated table because it only ADDS permitted values:
-- every existing row already satisfies the wider predicate, so the validation
-- scan on ADD CONSTRAINT cannot fail. Narrowing would need a data migration.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_type_check
  CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai', 'feedback', 'automation'));

-- The bulky half of a report. Kept out of `tasks` deliberately: task rows are
-- fanned out over realtime to every workspace client, and a few hundred console
-- lines per row does not belong in that broadcast. `tasks.source_id` holds this
-- row's id, so the task alone is enough to find the diagnostics.
CREATE TABLE IF NOT EXISTS feedback_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  -- The workspace the reporter was LOOKING AT, which is not the workspace the
  -- report lands in. Nullable and ON DELETE SET NULL: reports outlive it.
  source_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '',
  page jsonb NOT NULL DEFAULT '{}'::jsonb,
  selections jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb,
  build_id text DEFAULT '',
  user_agent text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_reports_workspace_id ON feedback_reports(workspace_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_task_id ON feedback_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_reporter_id ON feedback_reports(reporter_id);

-- ---------------------------------------------------------------------------
-- COST METERING
--
-- One row per paid provider call, recording COUNTS ONLY: tokens, characters or
-- seconds (`unit` says which), plus the provider and the resource that was
-- billed (the model id, the voice model, the room). NEVER a price — rates move,
-- and a price written into a row on the day of the call becomes a lie that
-- cannot be told apart from a current one. Money is computed at display time
-- from shared/usage-rates.cjs, which is the single place a rate may be edited.
--
-- Every column is a scalar. There is deliberately no jsonb here: this table
-- cannot then reproduce the bind bug where Fly needs an object and Netlify
-- needs the string.
--
-- workspace_id is ON DELETE SET NULL rather than CASCADE — deleting a workspace
-- must not delete the record of what it cost. Such a row leaves the per-account
-- rollup (nothing to attribute it to) and stays in the deployment total.
--
-- There is NO historical data before this table existed and none can be
-- invented, so app_settings.'usage.metering_started_at' stamps the epoch and
-- every figure on the Tenants screen is labelled "since" that date.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  -- 'anthropic' | 'deepgram' | 'cartesia' | 'livekit' | 'sandbox'
  provider text NOT NULL,
  -- What was billed: a model id, a voice model, a room. Free text on purpose —
  -- a new model must not need a migration to be metered.
  resource text NOT NULL DEFAULT '',
  -- Which code path spent it ('ai_chat', 'builtin_turn', 'auto_interject'…).
  kind text NOT NULL DEFAULT '',
  -- 'tokens' | 'characters' | 'seconds'
  unit text NOT NULL DEFAULT 'tokens',
  input_units bigint NOT NULL DEFAULT 0,
  output_units bigint NOT NULL DEFAULT 0,
  -- Kept apart from input_units because they are priced differently (a 5-minute
  -- cache write is 1.25x base input, a read 0.1x). Summing them would
  -- under-report writes and over-report reads.
  cache_write_units bigint NOT NULL DEFAULT 0,
  cache_read_units bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_created ON usage_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created ON usage_events(provider, created_at DESC);

INSERT INTO app_settings (key, value)
     VALUES ('usage.metering_started_at', now()::text)
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------------------
-- Interactive tool approvals (server/agent-permissions.cjs)
--
-- One row per "may I run this?" a daemon agent raised, and the answer a human
-- gave it. The row outlives the socket on purpose: a server restart must not
-- lose a prompt the daemon is still holding a turn open for.
--
-- `rules` holds the EXACT rule strings the daemon's "always allow" button would
-- grant (e.g. `Bash(git clone:*)`). Permanent grants are merged into
-- workspace_agents.metadata.permission_rules, which is MANAGE_ONLY in
-- shared/backend-core.cjs — so making one needs `manage` while unblocking a
-- running job needs only `write`.
CREATE TABLE IF NOT EXISTS agent_permission_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  job_id uuid,
  connection_id uuid,
  session_id uuid,
  message_id uuid,
  -- The daemon's own request id, unique per daemon process.
  request_key text NOT NULL,
  tool_name text NOT NULL DEFAULT '',
  tool_detail text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- pending | allowed | denied | expired
  status text NOT NULL DEFAULT 'pending',
  -- once | session | always, set only on an allow.
  scope text NOT NULL DEFAULT '',
  decided_by uuid,
  decided_by_name text NOT NULL DEFAULT '',
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A redelivered frame must update the prompt already on screen, never stack a
-- second one beside it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_permission_requests_key
  ON agent_permission_requests(connection_id, request_key);
CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_pending
  ON agent_permission_requests(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_job
  ON agent_permission_requests(job_id);

-- The transcript anchor for a request. Nullable: a request whose message insert
-- failed is still a real pending request, and dropping it would wedge the turn.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS permission_request_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_permission_request
  ON messages(permission_request_id) WHERE permission_request_id IS NOT NULL;

-- MCP OAuth 2.1 (authorization-code + PKCE) for remote MCP clients.
CREATE TABLE IF NOT EXISTS mcp_oauth_clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id text NOT NULL UNIQUE,
  client_secret_hash text NOT NULL DEFAULT '',
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  token_endpoint_auth_method text NOT NULL DEFAULT 'none',
  redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_clients_workspace
  ON mcp_oauth_clients(workspace_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_oauth_client_grants (
  client_id text NOT NULL REFERENCES mcp_oauth_clients(client_id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  granted_by uuid,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (client_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_client_grants_workspace
  ON mcp_oauth_client_grants(workspace_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_oauth_codes (
  code_hash text PRIMARY KEY,
  client_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  redirect_uri text NOT NULL,
  code_challenge text NOT NULL,
  code_challenge_method text NOT NULL DEFAULT 'S256',
  scopes jsonb NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_codes_client ON mcp_oauth_codes(client_id);

CREATE TABLE IF NOT EXISTS mcp_oauth_tokens (
  token_hash text PRIMARY KEY,
  client_id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid,
  scopes jsonb NOT NULL DEFAULT '["mcp:tools"]'::jsonb,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_mcp_oauth_tokens_workspace
  ON mcp_oauth_tokens(workspace_id) WHERE revoked_at IS NULL;
