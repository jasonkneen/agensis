-- Named, scoped workspace controllers and agent-stewarded shared resources.
-- These tables are intentionally absent from the generic DB/realtime allowlist.

CREATE TABLE IF NOT EXISTS workspace_controllers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  scopes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (
    jsonb_typeof(scopes) = 'array'
    AND jsonb_array_length(scopes) > 0
    AND scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  parent_controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
  expires_at timestamptz NOT NULL,
  last_used_at timestamptz,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_workspace_controllers_workspace
  ON workspace_controllers(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_controllers_parent
  ON workspace_controllers(parent_controller_id);

ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS controller_id uuid;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_agents_controller_id_fkey'
  ) THEN
    ALTER TABLE workspace_agents
      ADD CONSTRAINT workspace_agents_controller_id_fkey
      FOREIGN KEY (controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_workspace_agents_controller_id ON workspace_agents(controller_id);

ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS controller_id uuid;
ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_purpose text NOT NULL DEFAULT 'collaborator';
ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_requested_purpose_check;
ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_requested_purpose_check
  CHECK (requested_purpose IN ('collaborator', 'resource'));
ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_requested_resource_facets_check;
ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_requested_resource_facets_check CHECK (
  jsonb_typeof(requested_resource_facets) = 'array'
  AND requested_resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
);
ALTER TABLE agent_registrations DROP CONSTRAINT IF EXISTS agent_registrations_resource_facets_match_purpose;
ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_resource_facets_match_purpose CHECK (
  (requested_purpose = 'collaborator' AND requested_resource_facets = '[]'::jsonb)
  OR (requested_purpose = 'resource' AND jsonb_array_length(requested_resource_facets) > 0)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'agent_registrations_controller_id_fkey'
  ) THEN
    ALTER TABLE agent_registrations
      ADD CONSTRAINT agent_registrations_controller_id_fkey
      FOREIGN KEY (controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_agent_registrations_controller ON agent_registrations(controller_id, status);

ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS grant_kind text NOT NULL DEFAULT 'individual';
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_name text NOT NULL DEFAULT '';
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_scopes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS controller_expires_at timestamptz;
ALTER TABLE workspace_join_links ADD COLUMN IF NOT EXISTS redeemed_controller_id uuid;

ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_grant_kind_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_grant_kind_check
  CHECK (grant_kind IN ('individual', 'workspace_control'));
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_audience_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_audience_check
  CHECK (audience IN ('both', 'human', 'agent', 'controller'));
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_redeemed_as_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_redeemed_as_check
  CHECK (redeemed_as IN ('', 'human', 'agent', 'controller'));
ALTER TABLE workspace_join_links DROP CONSTRAINT IF EXISTS workspace_join_links_controller_shape_check;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_controller_shape_check CHECK (
    (
      grant_kind = 'individual'
      AND audience IN ('both', 'human', 'agent')
      AND controller_name = ''
      AND controller_scopes = '[]'::jsonb
      AND controller_expires_at IS NULL
    )
    OR
    (
      grant_kind = 'workspace_control'
      AND audience = 'controller'
      AND btrim(controller_name) <> ''
      AND jsonb_typeof(controller_scopes) = 'array'
      AND jsonb_array_length(controller_scopes) > 0
      AND controller_scopes <@ '["agents:register", "agents:manage_own", "resources:create", "resources:manage_own"]'::jsonb
      AND controller_expires_at IS NOT NULL
    )
  );
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'workspace_join_links_redeemed_controller_id_fkey'
  ) THEN
    ALTER TABLE workspace_join_links
      ADD CONSTRAINT workspace_join_links_redeemed_controller_id_fkey
      FOREIGN KEY (redeemed_controller_id) REFERENCES workspace_controllers(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS workspace_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  steward_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE RESTRICT,
  controller_id uuid REFERENCES workspace_controllers(id) ON DELETE SET NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  facet text NOT NULL CHECK (facet IN ('context', 'knowledge', 'tooling', 'code')),
  descriptor jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(descriptor) = 'object'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  visibility text NOT NULL DEFAULT 'workspace' CHECK (visibility IN ('workspace', 'restricted')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workspace_resources_workspace
  ON workspace_resources(workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_resources_steward
  ON workspace_resources(steward_agent_id, status);
CREATE INDEX IF NOT EXISTS idx_workspace_resources_controller
  ON workspace_resources(controller_id);

CREATE TABLE IF NOT EXISTS resource_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  resource_id uuid NOT NULL REFERENCES workspace_resources(id) ON DELETE CASCADE,
  steward_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE RESTRICT,
  requested_by_user_id uuid REFERENCES app_users(id) ON DELETE RESTRICT,
  requested_by_agent_id uuid REFERENCES workspace_agents(id) ON DELETE RESTRICT,
  requested_by_controller_id uuid REFERENCES workspace_controllers(id) ON DELETE RESTRICT,
  requested_by_workspace_id uuid REFERENCES workspaces(id) ON DELETE RESTRICT,
  requester_key text NOT NULL,
  claimed_by_agent_id uuid REFERENCES workspace_agents(id) ON DELETE SET NULL,
  operation text NOT NULL CHECK (operation IN ('read', 'propose', 'apply', 'publish')),
  input_artifact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(input_artifact) = 'object'),
  output_artifact jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(output_artifact) = 'object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'claimed', 'completed', 'rejected', 'failed', 'cancelled')),
  resource_version integer NOT NULL CHECK (resource_version > 0),
  idempotency_key text NOT NULL,
  attempt integer NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  lease_version bigint NOT NULL DEFAULT 0 CHECK (lease_version >= 0),
  lease_expires_at timestamptz,
  error text NOT NULL DEFAULT '',
  progress jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(progress) = 'object'),
  progress_seq bigint NOT NULL DEFAULT 0 CHECK (progress_seq >= 0),
  progress_updated_at timestamptz,
  audit_reference uuid REFERENCES audit_log(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  CONSTRAINT resource_operations_one_requester_check CHECK (
    num_nonnulls(requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id) = 1
  ),
  UNIQUE (workspace_id, requester_key, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_resource_operations_resource
  ON resource_operations(resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_resource_operations_claim
  ON resource_operations(steward_agent_id, status, created_at);
-- Controller ids are attribution, not authority, but they must never point
-- across tenants. The single-column FKs above cannot express that.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_controllers_id_workspace_key') THEN
    ALTER TABLE workspace_controllers ADD CONSTRAINT workspace_controllers_id_workspace_key UNIQUE (id, workspace_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_controllers_parent_workspace_fkey') THEN
    ALTER TABLE workspace_controllers ADD CONSTRAINT workspace_controllers_parent_workspace_fkey
      FOREIGN KEY (parent_controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (parent_controller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_agents_controller_workspace_fkey') THEN
    ALTER TABLE workspace_agents ADD CONSTRAINT workspace_agents_controller_workspace_fkey
      FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_resources_controller_workspace_fkey') THEN
    ALTER TABLE workspace_resources ADD CONSTRAINT workspace_resources_controller_workspace_fkey
      FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'agent_registrations_controller_workspace_fkey') THEN
    ALTER TABLE agent_registrations ADD CONSTRAINT agent_registrations_controller_workspace_fkey
      FOREIGN KEY (controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (controller_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspace_join_links_redeemed_controller_workspace_fkey') THEN
    ALTER TABLE workspace_join_links ADD CONSTRAINT workspace_join_links_redeemed_controller_workspace_fkey
      FOREIGN KEY (redeemed_controller_id, workspace_id) REFERENCES workspace_controllers(id, workspace_id) ON DELETE SET NULL (redeemed_controller_id);
  END IF;
END $$;

ALTER TABLE resource_operations ADD COLUMN IF NOT EXISTS requested_by_workspace_id uuid;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_one_requester_check;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_one_requester_check CHECK (
  num_nonnulls(requested_by_user_id, requested_by_agent_id, requested_by_controller_id, requested_by_workspace_id) = 1
);
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_user_id_fkey;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_agent_id_fkey;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_controller_id_fkey;
ALTER TABLE resource_operations DROP CONSTRAINT IF EXISTS resource_operations_requested_by_workspace_id_fkey;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_user_id_fkey
  FOREIGN KEY (requested_by_user_id) REFERENCES app_users(id) ON DELETE RESTRICT;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_agent_id_fkey
  FOREIGN KEY (requested_by_agent_id) REFERENCES workspace_agents(id) ON DELETE RESTRICT;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_controller_id_fkey
  FOREIGN KEY (requested_by_controller_id) REFERENCES workspace_controllers(id) ON DELETE RESTRICT;
ALTER TABLE resource_operations ADD CONSTRAINT resource_operations_requested_by_workspace_id_fkey
  FOREIGN KEY (requested_by_workspace_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
