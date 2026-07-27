/*
  # Workspace-level inference gateway configs

  A gateway_config points a chat session's inference at an external
  OpenAI-compatible endpoint. The API key is stored encrypted
  (api_key_cipher, AES-256-GCM via the workspace vault key); the plaintext
  key is never persisted or returned to the client.
*/

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
