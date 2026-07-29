-- WORKSPACE-AUTHORED SKILLS. The app-side skill store.
--
-- WHY. Until now a skill BODY could only live in `agent_skill_documents`, and
-- that table is daemon-owned: rows are written by an `agent_skill_sync` push
-- from a connected daemon, keyed per agent, read-only in-app, and the table is
-- absent from ALLOWED_TABLES entirely, so a browser cannot write it at all.
-- There was therefore NO writable, workspace-scoped skill store, and two
-- shipped features were bent around the hole:
--
--   1. Suggestions accepted a proposed SKILL as a Document in a "Skills"
--      folder, because (server/thread-harvest.cjs) there was "no app-side skill
--      store to accept into", and attaching a bare name to
--      `workspace_agents.skills` "would record a claim without the procedure
--      that makes it true".
--   2. An agent template carries a `skills` list of NAMES, so a template saying
--      skills: ['security-review'] exported a DANGLING REFERENCE into any
--      workspace where no daemon happened to have that file.
--
-- WHAT A SKILL IS. A named markdown document with a one-line summary — the
-- agentskills.io SKILL.md shape, which is already what the daemon parses, what
-- agent_skill_documents stores, and what `read_skill` returns. Nothing new was
-- invented; the shape was taken from what already consumes one.
--
-- SYNC DIRECTION IS UNCHANGED, AND THAT IS DELIBERATE. Skills still flow UP
-- from daemons into agent_skill_documents. NOTHING in this table flows DOWN
-- onto anybody's disk: an app-side row that wrote a file onto a user's machine
-- would be a strictly larger authority than any daemon holds today, and the
-- same category as `metadata.host_folders` -> `--add-dir <path>`, which is
-- MANAGE_ONLY on the agent row for exactly that reason. Agents reach these
-- bodies at turn time through the `read_skill` MCP tool, which already existed,
-- already wraps a body in an untrusted-data fence, and already reads STORED
-- content — so a skill stays readable while every daemon is offline, which is
-- the whole point of storing it rather than fetching it.
--
-- THE ABSENT COLUMNS ARE THE SECURITY CONTROL, and this comment is the reason
-- adding one later is a security decision rather than a schema tidy-up.
--
-- There is deliberately no base_url, credential, endpoints, mcp, code,
-- provider, capabilities, path, agent_id, tools, metadata or permission_mode
-- column. A workspace skill carries PROSE; it never carries AUTHORITY.
--
--   base_url / endpoints  a host THE SERVER FETCHES with a stored credential
--                         attached (planProviderCall in
--                         server/sandbox-skills.cjs). This repo already has one
--                         live SSRF finding from an unvalidated base_url.
--   credential            names a workspace-vault key. A prose artifact that
--                         could pick which secret signs a call is not prose.
--   code / mcp            a script, and an MCP front door.
--   path / memory_dir     filesystem paths on somebody's real machine.
--   tools / permission_mode  what an agent MAY DO. A skill describes a
--                         procedure; it never widens the surface it runs on.
--   agent_id              a workspace skill belongs to the WORKSPACE. Keying
--                         one to an agent would rebuild agent_skill_documents,
--                         which is daemon-owned by design.
--   source / origin       provenance, set by the route and never by a caller —
--                         a caller that could claim source='authored' on an
--                         imported body would erase the only record of where
--                         attacker-influenced prose came from.
--
-- The privilege-bearing skill shape is NOT homeless: it lives in
-- `workspace_agents.metadata.sandbox_skills`, which is MANAGE_ONLY, validated by
-- server/sandbox-skills.cjs, and unchanged by this migration.
--
-- ROLE. Authoring is 'write', matching workspace_agent_templates, because a
-- 'write' member can already type prose straight into an agent's system_prompt,
-- which an agent obeys as TRUSTED text every turn — while a skill body arrives
-- FENCED as untrusted reference data. Generic /backend/db writes on this table
-- are gated to 'manage' so the ordinary path is the dedicated route, which is
-- the only place the validator (shared/workspaceSkills.cjs) runs.

CREATE TABLE IF NOT EXISTS workspace_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- agentskills.io's name rule (lowercase, digits, single hyphens, <= 64),
  -- enforced by the validator: this value is the lookup key for read_skill, the
  -- folder name if the skill is ever exported, and an element of a template's
  -- `skills` array.
  name text NOT NULL,
  title text NOT NULL,
  summary text DEFAULT '',
  -- Capped at 64 KiB by the validator, matching SKILL_CONTENT_MAX_BYTES in
  -- server/skill-content.cjs: the body is read back through the same loader that
  -- caps a daemon-mirrored document, so a larger one would only be truncated on
  -- the way out.
  body text NOT NULL,
  revision integer NOT NULL DEFAULT 1,
  -- 'authored' (typed here), 'suggested' (accepted from a thread harvest),
  -- 'imported' (crossed a workspace boundary).
  source text NOT NULL DEFAULT 'authored',
  origin jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_workspace_skills_workspace_id
  ON workspace_skills(workspace_id);
