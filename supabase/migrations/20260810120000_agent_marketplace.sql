-- The agent marketplace: cross-workspace listings ('template' shares the
-- persona body; 'hire' shares capabilities only) plus the hire records.
-- Mirrors ensureRuntimeSchema in server/index.cjs and database/neon-schema.sql.

-- THE AGENT MARKETPLACE. Cross-workspace listings of agents, in two shapes:
-- 'template' (the persona body travels and is copied through the existing
-- review-before-instantiate Agents-window form) and 'hire' (the body stays
-- with the publisher; the hirer gets a Connector roster entry served by the
-- host's own runtime). Validator: shared/marketplace.cjs. Routes:
-- server/marketplace-routes.cjs. Deliberately ABSENT from ALLOWED_TABLES —
-- the dedicated routes are the only doors, so the validator always runs.
--
-- THE ABSENT COLUMNS ARE THE SECURITY CONTROL, same rule as
-- workspace_agent_templates: no permission_mode ('yolo' is unrestricted shell
-- on the daemon host), no metadata (host_folders becomes an --add-dir
-- argument on somebody's actual machine; sandbox_skills names a baseUrl the
-- server fetches plus a vault credential), no sandbox config, no connect
-- token, no identity. A listing carries prose and requests; it never carries
-- authority — and here the artifact crosses TENANT boundaries, so adding one
-- of those columns later is a security decision, not a schema tidy-up.
--
-- A 'hire' listing additionally carries NO PERSONA BODY AT ALL: the CHECK
-- below refuses a hire row with non-empty prose columns, so "the hirer never
-- sees the prompt or skills" is a property of the schema rather than of a
-- projection some future call site forgets.
CREATE TABLE IF NOT EXISTS marketplace_listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  publisher_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  listing_type text NOT NULL CHECK (listing_type IN ('template', 'hire')),
  name text NOT NULL,
  category text NOT NULL DEFAULT 'Community',
  description text DEFAULT '',
  -- The publisher's own words for what the agent can do — the ONLY detail a
  -- hire listing shows. string[].
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Template body ('template' listings only). Same carried fields as
  -- workspace_agent_templates; tools and skills MUST stay string[] — the
  -- Agents window round-trips skills through a comma-separated input.
  handle_hint text DEFAULT '',
  system_prompt text DEFAULT '',
  soul text DEFAULT '',
  instructions text DEFAULT '',
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  purpose text NOT NULL DEFAULT 'collaborator'
    CHECK (purpose IN ('collaborator', 'resource')),
  resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(resource_facets) = 'array'
      AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    ),
  model text NOT NULL DEFAULT 'auto',
  run_mode text NOT NULL DEFAULT 'builtin',
  runtime text DEFAULT '',
  avatar text DEFAULT '',
  accent_color text DEFAULT '',
  -- 'hire' only: which host agent serves hires. Never projected to
  -- marketplace browsers; the listing dies with the host agent.
  source_agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
  fingerprint text DEFAULT '',
  status text NOT NULL DEFAULT 'published' CHECK (status IN ('published', 'unlisted')),
  install_count integer NOT NULL DEFAULT 0,
  hire_count integer NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  CONSTRAINT marketplace_listings_hire_carries_no_body CHECK (
    listing_type = 'template' OR (
      system_prompt = '' AND soul = '' AND instructions = ''
      AND tools = '[]'::jsonb AND skills = '[]'::jsonb
    )
  ),
  CONSTRAINT marketplace_listings_type_matches_source CHECK (
    (listing_type = 'hire') = (source_agent_id IS NOT NULL)
  ),
  CONSTRAINT marketplace_listings_resource_facets_match_purpose CHECK (
    (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
    OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
  ),
  UNIQUE (publisher_workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_listings_publisher
  ON marketplace_listings(publisher_workspace_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_listings_type_status
  ON marketplace_listings(listing_type, status);

-- One workspace hiring one listing. The hired roster row is a Connector shell
-- (run_mode 'external', no prose, permission_mode 'default') created by the
-- manage-gated hire route from hiredAgentDraft — never from caller fields.
-- listing_id survives an unpublish as NULL; the host ids are a snapshot so
-- the hirer's bookkeeping outlives the host side.
CREATE TABLE IF NOT EXISTS marketplace_hires (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid REFERENCES marketplace_listings(id) ON DELETE SET NULL,
  hirer_workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  hired_agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  host_workspace_id uuid,
  host_agent_id uuid,
  listing_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (hirer_workspace_id, hired_agent_id)
);

CREATE INDEX IF NOT EXISTS idx_marketplace_hires_hirer
  ON marketplace_hires(hirer_workspace_id);
CREATE INDEX IF NOT EXISTS idx_marketplace_hires_listing
  ON marketplace_hires(listing_id);
