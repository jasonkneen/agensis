-- Close the remaining historical gap between ensureRuntimeSchema, the canonical
-- Neon schema, and the forward migration chain. These tables already exist in
-- both runtime bootstrap and database/neon-schema.sql; this migration makes a
-- migration-only deployment produce the same durable feature set.

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
CREATE INDEX IF NOT EXISTS idx_agent_memory_files_workspace_id
  ON agent_memory_files(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_memory_files_agent_id
  ON agent_memory_files(agent_id);

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
CREATE INDEX IF NOT EXISTS idx_memory_file_comments_workspace_id
  ON memory_file_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_memory_file_comments_agent_path
  ON memory_file_comments(agent_id, path);
CREATE INDEX IF NOT EXISTS idx_memory_file_comments_parent_id
  ON memory_file_comments(parent_id);

CREATE TABLE IF NOT EXISTS farm_integration_device_codes (
  id uuid PRIMARY KEY,
  device_code_hash text NOT NULL UNIQUE,
  user_code text NOT NULL UNIQUE,
  name text NOT NULL DEFAULT 'Agent Farm',
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'consumed')),
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
CREATE INDEX IF NOT EXISTS idx_farm_device_user_code
  ON farm_integration_device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_farm_device_expires_at
  ON farm_integration_device_codes(expires_at);

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
CREATE INDEX IF NOT EXISTS idx_farm_integrations_workspace
  ON farm_integrations(workspace_id, revoked_at);

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
  status text NOT NULL DEFAULT 'created'
    CHECK (status IN ('created', 'claimed', 'expired', 'revoked')),
  metadata jsonb DEFAULT '{}'::jsonb,
  expires_at timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
  claimed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_workspace
  ON cursorbuddy_connection_keys(workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_cursorbuddy_connection_keys_hash
  ON cursorbuddy_connection_keys(key_hash);

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
CREATE INDEX IF NOT EXISTS idx_activity_event_comments_workspace_id
  ON activity_event_comments(workspace_id);
CREATE INDEX IF NOT EXISTS idx_activity_event_comments_event_id
  ON activity_event_comments(event_id);
CREATE INDEX IF NOT EXISTS idx_activity_event_comments_parent_id
  ON activity_event_comments(parent_id);

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
CREATE INDEX IF NOT EXISTS idx_agent_schedules_workspace_id
  ON agent_schedules(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_schedules_due
  ON agent_schedules(next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS agent_schedule_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id uuid NOT NULL REFERENCES agent_schedules(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'ok',
  detail text DEFAULT '',
  created_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_schedule
  ON agent_schedule_runs(schedule_id, created_at DESC);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_schedules_interval_bounds'
  ) THEN
    ALTER TABLE agent_schedules
      ADD CONSTRAINT agent_schedules_interval_bounds
      CHECK (interval_seconds >= 60 AND interval_seconds <= 2592000);
  END IF;
END $$;
