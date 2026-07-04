-- CursorBuddy schema contract for the Agensis database.
-- This is intentionally staged as a contract, not an applied migration.
-- It extends existing Agensis users, workspaces, workspace_members, workspace_agents,
-- and workspace_secrets rather than creating a standalone account universe.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS cursorbuddy_profiles (
  user_id uuid PRIMARY KEY REFERENCES app_users(id) ON DELETE CASCADE,
  username text UNIQUE,
  display_name text NOT NULL DEFAULT '',
  avatar_url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closing', 'closed')),
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursorbuddy_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_group_id uuid REFERENCES cursorbuddy_groups(id) ON DELETE CASCADE,
  name text NOT NULL,
  slug text NOT NULL,
  description text NOT NULL DEFAULT '',
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, parent_group_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_cursorbuddy_groups_workspace
  ON cursorbuddy_groups(workspace_id);

CREATE TABLE IF NOT EXISTS cursorbuddy_pets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  group_id uuid REFERENCES cursorbuddy_groups(id) ON DELETE SET NULL,
  name text NOT NULL,
  character_key text NOT NULL DEFAULT 'scrapper',
  style_key text NOT NULL DEFAULT 'std',
  definition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  sprite_pack_url text NOT NULL DEFAULT '',
  collectible_key text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'archived', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cursorbuddy_pets_workspace
  ON cursorbuddy_pets(workspace_id);

CREATE TABLE IF NOT EXISTS cursorbuddy_accessories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  name text NOT NULL,
  category text NOT NULL,
  asset_key text NOT NULL,
  definition_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('draft', 'active', 'archived', 'revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursorbuddy_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  owner_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  group_id uuid REFERENCES cursorbuddy_groups(id) ON DELETE SET NULL,
  default_pet_id uuid REFERENCES cursorbuddy_pets(id) ON DELETE SET NULL,
  label text NOT NULL,
  surface text NOT NULL
    CHECK (surface IN ('web', 'extension', 'desktop', 'mobile', 'sdk')),
  install_key text NOT NULL UNIQUE,
  origin text NOT NULL DEFAULT '',
  app_bundle_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'disabled', 'revoked')),
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cursorbuddy_instances_workspace
  ON cursorbuddy_instances(workspace_id);

CREATE TABLE IF NOT EXISTS cursorbuddy_client_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL
    CHECK (scope_type IN ('user', 'workspace', 'group', 'instance')),
  scope_id uuid NOT NULL,
  allowed_pet_ids uuid[] NOT NULL DEFAULT '{}',
  allowed_accessory_ids uuid[] NOT NULL DEFAULT '{}',
  default_pet_id uuid REFERENCES cursorbuddy_pets(id) ON DELETE SET NULL,
  allow_user_pet_override boolean NOT NULL DEFAULT true,
  allow_user_provider_override boolean NOT NULL DEFAULT false,
  ui_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  agent_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS cursorbuddy_provider_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL
    CHECK (scope_type IN ('user', 'workspace', 'group', 'instance')),
  scope_id uuid NOT NULL,
  provider text NOT NULL,
  base_url text NOT NULL DEFAULT '',
  default_model text NOT NULL DEFAULT '',
  allowed_models text[] NOT NULL DEFAULT '{}',
  workspace_secret_key text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id, provider)
);

CREATE TABLE IF NOT EXISTS cursorbuddy_agensis_configs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type text NOT NULL
    CHECK (scope_type IN ('user', 'workspace', 'group', 'instance')),
  scope_id uuid NOT NULL,
  home_url text NOT NULL DEFAULT '',
  cli_workspace text NOT NULL DEFAULT '',
  agent_package text NOT NULL DEFAULT '',
  allowed_agent_ids uuid[] NOT NULL DEFAULT '{}',
  allowed_skills text[] NOT NULL DEFAULT '{}',
  dial_home_enabled boolean NOT NULL DEFAULT true,
  workspace_secret_key text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (scope_type, scope_id)
);

CREATE TABLE IF NOT EXISTS cursorbuddy_agent_bindings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instance_id uuid NOT NULL REFERENCES cursorbuddy_instances(id) ON DELETE CASCADE,
  workspace_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  pet_id uuid REFERENCES cursorbuddy_pets(id) ON DELETE SET NULL,
  label text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'stopping', 'stopped', 'disabled')),
  pause_until timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, workspace_agent_id)
);

CREATE TABLE IF NOT EXISTS cursorbuddy_agent_commands (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  binding_id uuid NOT NULL REFERENCES cursorbuddy_agent_bindings(id) ON DELETE CASCADE,
  command text NOT NULL
    CHECK (command IN ('pause', 'resume', 'stop', 'restart', 'reconfigure')),
  requested_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'acknowledged', 'failed', 'expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz
);

CREATE TABLE IF NOT EXISTS cursorbuddy_billing_customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  stripe_customer_id text NOT NULL UNIQUE,
  billing_email text NOT NULL DEFAULT '',
  tax_details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS cursorbuddy_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_customer_id uuid NOT NULL REFERENCES cursorbuddy_billing_customers(id) ON DELETE CASCADE,
  stripe_subscription_id text NOT NULL UNIQUE,
  plan_slug text NOT NULL,
  status text NOT NULL,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursorbuddy_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  billing_customer_id uuid NOT NULL REFERENCES cursorbuddy_billing_customers(id) ON DELETE CASCADE,
  stripe_invoice_id text NOT NULL UNIQUE,
  status text NOT NULL,
  amount_due_cents integer NOT NULL DEFAULT 0,
  amount_paid_cents integer NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'usd',
  hosted_invoice_url text NOT NULL DEFAULT '',
  invoice_pdf_url text NOT NULL DEFAULT '',
  issued_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursorbuddy_credit_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
  source text NOT NULL,
  action_key text NOT NULL,
  delta_credits integer NOT NULL,
  balance_after integer NOT NULL,
  related_id text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (workspace_id IS NOT NULL OR user_id IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS cursorbuddy_support_tickets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  subject text NOT NULL,
  priority text NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'waiting', 'resolved', 'closed')),
  body text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS cursorbuddy_account_closure_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  requested_by_user_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  reason text NOT NULL DEFAULT '',
  export_requested boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'exporting', 'scheduled', 'cancelled', 'complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  scheduled_delete_at timestamptz
);
