-- Agent templates ("persona packs") as DATA rather than code.
--
-- agensis already had the substance of a persona: an agent's prompt layers,
-- tool list, skill list, model, run mode and execution config are all columns on
-- workspace_agents. What was missing was narrow — the 15 agent templates live in
-- a frontend array and can only be changed by editing that file and deploying.
-- A user could not author one, could not save an agent they had tuned as a
-- starting point for the next, and could not move one between workspaces.
--
-- THE ABSENT COLUMNS ARE THE SECURITY CONTROL, and this comment is the reason
-- adding one later is a security decision rather than a schema tidy-up.
--
-- There is deliberately no permission_mode, metadata, sandbox_provider,
-- sandbox_config, connect_token_hash, connect_token, mcp_approved, memory_dir
-- or identity column here. A template carries PROSE and REQUESTS; it never
-- carries AUTHORITY. You cannot import what the shape cannot hold.
--
--   permission_mode  'yolo' is unrestricted shell on the daemon host. It sits in
--                    PRIVILEGED_DB_COLUMNS_BY_TABLE so no generic write reaches
--                    it, and changing it is audited.
--   metadata         the one that looks harmless and is not. It carries
--                    host_folders, which the daemon turns into `--add-dir
--                    <path>` on somebody's actual machine, and sandbox_skills,
--                    whose definitions hold a baseUrl the SERVER will fetch and
--                    a credential naming a workspace-vault key. MANAGE_ONLY on
--                    workspace_agents for exactly those reasons.
--
-- Instantiating a template prefills the existing Agents window form and the
-- write still goes through the generic /backend/db/insert, where
-- stripPrivilegedDbValues and setsManageOnlyDbColumn apply unchanged. This
-- feature adds NO new write path to workspace_agents.

CREATE TABLE IF NOT EXISTS workspace_agent_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slug text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'Custom',
  description text DEFAULT '',
  handle_hint text DEFAULT '',
  system_prompt text DEFAULT '',
  soul text DEFAULT '',
  instructions text DEFAULT '',
  -- Both string[], and skills MUST stay string[]: the Agents window round-trips
  -- it through a comma-separated text input, so an object in that array renders
  -- '[object Object]' and is then saved back OVER the real definition on the
  -- next unrelated edit.
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  skills jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text NOT NULL DEFAULT 'auto',
  run_mode text NOT NULL DEFAULT 'builtin',
  runtime text DEFAULT '',
  avatar text DEFAULT '',
  accent_color text DEFAULT '',
  revision integer NOT NULL DEFAULT 1,
  -- Provenance. 'authored' (typed here), 'derived' (saved from an agent),
  -- 'imported' (crossed a workspace boundary). Written only by the dedicated
  -- routes -- both columns are privileged on the generic path, because a write
  -- that could set source='authored' on an imported template would erase the
  -- trail.
  source text NOT NULL DEFAULT 'authored',
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, slug)
);

CREATE INDEX IF NOT EXISTS idx_workspace_agent_templates_workspace_id
  ON workspace_agent_templates(workspace_id);
