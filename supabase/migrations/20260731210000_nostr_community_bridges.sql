-- Import a Nostr community as one Nostr connection with many channel bridges.
-- Private key material is held in encrypted workspace_secrets, never here.

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

ALTER TABLE channel_bridges
  ADD COLUMN IF NOT EXISTS nostr_connection_id uuid
  REFERENCES nostr_community_connections(id) ON DELETE CASCADE;
ALTER TABLE channel_bridges
  ADD COLUMN IF NOT EXISTS nostr_last_event_at bigint NOT NULL DEFAULT 0;
ALTER TABLE channel_bridges
  ADD COLUMN IF NOT EXISTS nostr_initial_sync_completed boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_channel_bridges_nostr_connection
  ON channel_bridges(nostr_connection_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_channel_bridges_nostr_channel
  ON channel_bridges(nostr_connection_id, external_id)
  WHERE nostr_connection_id IS NOT NULL;

ALTER TABLE channel_bridges DROP CONSTRAINT IF EXISTS channel_bridges_provider_check;
ALTER TABLE channel_bridges ADD CONSTRAINT channel_bridges_provider_check
  CHECK (provider IN ('telegram', 'slack', 'whatsapp', 'signal', 'openclaw', 'nostr'));
