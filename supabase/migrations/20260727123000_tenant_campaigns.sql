-- Owner broadcasts: segment accounts by behaviour, send one in-app message.
--
-- Third of the three places a schema change must land (ensureRuntimeSchema in
-- server/index.cjs and database/neon-schema.sql are the other two). Every
-- statement is idempotent so re-running the migration over a database the
-- runtime bootstrap already touched is a no-op.
--
-- Neither table is workspace-scoped, and neither is in the backendClient
-- allowlists: they are reached only through the owner-gated /backend/tenants
-- campaign routes and the per-user /backend/campaign-messages routes.

CREATE TABLE IF NOT EXISTS tenant_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  -- 'tip' | 'dialog' | 'banner'. Deliberately unconstrained text, normalized in
  -- shared/tenant-campaigns.cjs: an unreadable value reads as 'tip', so a row
  -- written by a newer build renders somewhere rather than nowhere, and adding a
  -- fourth surface needs no migration.
  surface text NOT NULL DEFAULT 'tip',
  segment jsonb NOT NULL DEFAULT '{}'::jsonb,
  segment_summary text NOT NULL DEFAULT '',
  recipient_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_by_email text NOT NULL DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_campaigns_created_at ON tenant_campaigns(created_at DESC);

CREATE TABLE IF NOT EXISTS tenant_campaign_recipients (
  campaign_id uuid NOT NULL REFERENCES tenant_campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  dismissed_at timestamptz,
  PRIMARY KEY (user_id, campaign_id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_campaign_recipients_campaign
  ON tenant_campaign_recipients(campaign_id);
