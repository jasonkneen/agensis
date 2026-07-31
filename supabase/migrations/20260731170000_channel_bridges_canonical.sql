-- Bring external channel bridges under the canonical migration chain. Runtime
-- startup previously created both tables, while a migration-only deployment did
-- not. agent_connections is established by the preceding 160000 migration.
CREATE TABLE IF NOT EXISTS channel_bridges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  provider text NOT NULL
    CHECK (provider IN ('telegram', 'slack', 'whatsapp', 'signal', 'openclaw')),
  lane text NOT NULL CHECK (lane IN ('hub', 'daemon')),
  external_id text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
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
CREATE INDEX IF NOT EXISTS idx_channel_bridges_workspace_id
  ON channel_bridges(workspace_id);
CREATE INDEX IF NOT EXISTS idx_channel_bridges_session_id
  ON channel_bridges(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bridges_session
  ON channel_bridges(session_id);

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
CREATE INDEX IF NOT EXISTS idx_bridge_messages_message_id
  ON bridge_messages(message_id);
