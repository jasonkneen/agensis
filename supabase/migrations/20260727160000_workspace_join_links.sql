-- The ONE join link: a single short-lived, single-use URL that a human OR an
-- agent can redeem. Redeeming provisions the real credential server-side; the
-- link itself is never a credential and appears in no auth path.
--
-- Separate from workspace_invites on purpose: that table's rows live 14 days AND
-- double as usable MCP bearer tokens for the whole window (verifyInviteToken).
-- A join link lives minutes, works once, and can authenticate nothing.
--
-- Only the token HASH is stored, like connect_token_hash / mcp_token_hash. The
-- plaintext exists in the mint response and in the URL its creator copies;
-- nothing can recover it afterwards.

CREATE TABLE IF NOT EXISTS workspace_join_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  label text NOT NULL DEFAULT '',
  -- The role a HUMAN gets on redeeming. An agent's abilities are governed by
  -- agent RBAC (kinds: ['agent']), not by this.
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
  audience text NOT NULL DEFAULT 'both' CHECK (audience IN ('both', 'human', 'agent')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'redeemed', 'revoked')),
  redeemed_as text NOT NULL DEFAULT '' CHECK (redeemed_as IN ('', 'human', 'agent')),
  redeemed_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  redeemed_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  redeemed_at timestamptz,
  expires_at timestamptz NOT NULL,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_join_links_workspace_id ON workspace_join_links(workspace_id, created_at DESC);
