-- Interactive tool approvals.
--
-- A daemon agent runs headless on someone else's machine, so the coding CLI's
-- own permission prompt has nobody in front of it and the settings files an
-- operator would write grants into are never read. This table is where the
-- question goes instead: one row per "may I run this?", plus the answer.
--
-- Mirrors ensureAgentPermissionsSchema in server/agent-permissions.cjs and the
-- block appended to database/neon-schema.sql.

CREATE TABLE IF NOT EXISTS agent_permission_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  job_id uuid,
  connection_id uuid,
  session_id uuid,
  message_id uuid,
  request_key text NOT NULL,
  tool_name text NOT NULL DEFAULT '',
  tool_detail text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  rules jsonb NOT NULL DEFAULT '[]'::jsonb,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  scope text NOT NULL DEFAULT '',
  decided_by uuid,
  decided_by_name text NOT NULL DEFAULT '',
  decided_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_permission_requests_key
  ON agent_permission_requests(connection_id, request_key);
CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_pending
  ON agent_permission_requests(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_permission_requests_job
  ON agent_permission_requests(job_id);

ALTER TABLE messages ADD COLUMN IF NOT EXISTS permission_request_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_permission_request
  ON messages(permission_request_id) WHERE permission_request_id IS NOT NULL;
