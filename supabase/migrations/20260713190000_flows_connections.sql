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
