-- Agent purpose is descriptive intent, deliberately orthogonal to execution.
-- It grants no permission mode, tools, host folders, runtime placement, token,
-- or other authority. Existing rows remain collaborators.

ALTER TABLE workspace_agents
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'collaborator'
    CHECK (purpose IN ('collaborator', 'resource'));

ALTER TABLE workspace_agents
  ADD COLUMN IF NOT EXISTS resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(resource_facets) = 'array'
      AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    );

ALTER TABLE workspace_agents
  DROP CONSTRAINT IF EXISTS workspace_agents_resource_facets_match_purpose;
ALTER TABLE workspace_agents
  ADD CONSTRAINT workspace_agents_resource_facets_match_purpose CHECK (
    (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
    OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
  );

-- Templates may carry the same safe intent fields. They still cannot carry
-- permission_mode, metadata, sandbox config, tokens, identity, or placement.
ALTER TABLE workspace_agent_templates
  ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'collaborator'
    CHECK (purpose IN ('collaborator', 'resource'));

ALTER TABLE workspace_agent_templates
  ADD COLUMN IF NOT EXISTS resource_facets jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (
      jsonb_typeof(resource_facets) = 'array'
      AND resource_facets <@ '["context", "knowledge", "tooling", "code"]'::jsonb
    );

ALTER TABLE workspace_agent_templates
  DROP CONSTRAINT IF EXISTS workspace_agent_templates_resource_facets_match_purpose;
ALTER TABLE workspace_agent_templates
  ADD CONSTRAINT workspace_agent_templates_resource_facets_match_purpose CHECK (
    (purpose = 'collaborator' AND resource_facets = '[]'::jsonb)
    OR (purpose = 'resource' AND jsonb_array_length(resource_facets) > 0)
  );
