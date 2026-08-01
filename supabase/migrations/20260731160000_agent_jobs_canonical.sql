-- Bring agent_jobs under the canonical migration chain. It was previously
-- created only by server/index.cjs ensureRuntimeSchema, which made production
-- startup repair a database that the documented migration path left incomplete.
-- agent_jobs references agent_connections, which was also missing from the
-- historical migration chain, so establish that prerequisite first.
CREATE TABLE IF NOT EXISTS agent_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Agent',
  handle text NOT NULL DEFAULT '',
  host text DEFAULT '',
  cwd text DEFAULT '',
  status text NOT NULL DEFAULT 'offline'
    CHECK (status IN ('online', 'offline', 'busy')),
  metadata jsonb DEFAULT '{}'::jsonb,
  capabilities jsonb DEFAULT '{}'::jsonb,
  connected_at timestamptz DEFAULT now(),
  last_seen_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_agent_connections_workspace_id
  ON agent_connections(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_connections_agent_id
  ON agent_connections(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_connections_status
  ON agent_connections(workspace_id, status);

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

-- The runtime bootstrap already heals historical duplicates before adding this
-- index. Do the same in the migration so enabling AGENSIS_RUNTIME_SCHEMA=false
-- is safe on an older database too.
DELETE FROM agent_jobs a
USING agent_jobs b
WHERE a.status IN ('queued', 'running')
  AND b.status IN ('queued', 'running')
  AND a.session_id = b.session_id
  AND a.agent_id = b.agent_id
  AND (
    a.created_at < b.created_at
    OR (a.created_at = b.created_at AND a.ctid > b.ctid)
  );

CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_active_per_session_agent
  ON agent_jobs(session_id, agent_id)
  WHERE status IN ('queued', 'running');
