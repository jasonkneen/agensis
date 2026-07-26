-- Agent skill documents: the BODY behind a skill name a daemon advertises.
--
-- `agent_connections.capabilities.skills` is a list of NAMES, so the Skills
-- browser could show who has a skill but never what it says. A daemon mirrors
-- the real SKILL.md here with an `agent_skill_sync` push, exactly as it already
-- mirrors the memory palace into agent_memory_files.
--
-- Read-only in-app: the daemon is the only writer, and the browser reads it
-- through /backend/system/skill-content rather than the generic table API, so
-- the table is deliberately absent from the backendClient allowlists.

CREATE TABLE IF NOT EXISTS agent_skill_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  skill text NOT NULL,
  path text DEFAULT '',
  summary text DEFAULT '',
  content text DEFAULT '',
  byte_size bigint DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  last_synced timestamptz DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (agent_id, skill)
);

CREATE INDEX IF NOT EXISTS idx_agent_skill_documents_workspace_id ON agent_skill_documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_skill_documents_agent_id ON agent_skill_documents(agent_id);
