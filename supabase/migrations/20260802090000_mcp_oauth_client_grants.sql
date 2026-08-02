-- Workspace-scoped grants let one dynamic OAuth client be authorized and
-- revoked independently across multiple workspaces.
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

INSERT INTO mcp_oauth_client_grants (client_id, workspace_id, granted_by)
SELECT client_id, workspace_id, created_by
  FROM mcp_oauth_clients
 WHERE workspace_id IS NOT NULL
UNION
SELECT c.client_id, c.workspace_id, c.user_id
  FROM mcp_oauth_codes c
UNION
SELECT t.client_id, t.workspace_id, t.user_id
  FROM mcp_oauth_tokens t
ON CONFLICT (client_id, workspace_id) DO NOTHING;
