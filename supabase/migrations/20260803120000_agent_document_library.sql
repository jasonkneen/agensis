-- Connected-agent document discovery.
--
-- Two changes, one feature:
--
--   1. workspace_agents.sharing — what an agent CONTRIBUTES to the workspace.
--   2. agent_documents — the markdown a connected agent mirrors up from its own
--      locations, so the workspace has one library of everything its agents can
--      see rather than one browse surface per agent.

-- ---------------------------------------------------------------------------
-- 1. Per-agent sharing switches: {memory, skills, tools, documents}.
--
-- DEFAULT '{}' and read FAIL-OPEN (absent key means shared; only an explicit
-- false withholds) — see shared/agentSharing.cjs. Every one of those channels
-- was already mirroring for every connected agent before this column existed,
-- so a default that read as "off" would empty three browse surfaces on deploy
-- and nothing would error. Same reasoning as ambient_replies.
--
-- The flags are enforced at INGEST in server/agent-connections.cjs: a withheld
-- channel refuses the daemon's push AND prunes the rows that agent already
-- mirrored. A flag that only hid rows in the UI would leave the bodies sitting
-- in the workspace database, which is not what switching sharing off means.
-- ---------------------------------------------------------------------------
ALTER TABLE workspace_agents
  ADD COLUMN IF NOT EXISTS sharing jsonb NOT NULL DEFAULT '{}'::jsonb;

-- ---------------------------------------------------------------------------
-- 2. agent_documents — third member of the daemon-mirror family.
--
-- Same shape as agent_memory_files and agent_skill_documents on purpose:
-- daemon-written, read-only in-app, UPSERT by UNIQUE(agent_id, path), prune
-- what the daemon stopped reporting. One pattern for "a daemon pushed files
-- up", not three.
--
-- These are NOT rows in `documents`. That table is workspace-authored, editable
-- in the app, and each row is the only copy of itself. These are read-only
-- snapshots of files on other machines, and the SAME document routinely arrives
-- from several agents at once — three checkouts of one repo is the normal case.
-- Merging them into `documents` would either collapse those into a single row
-- (losing exactly the disagreement the library exists to surface) or fill the
-- sidebar with duplicates. The collation runs in src/lib/documentLibrary.ts,
-- across both tables, where one row can carry many sources.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES workspace_agents(id) ON DELETE CASCADE,
  path text NOT NULL,
  title text NOT NULL DEFAULT '',
  -- The daemon's own grouping hint (a folder, a repo area). Advisory: the
  -- library derives a domain from the path when this is empty, so a daemon that
  -- sends nothing still groups sensibly.
  domain text NOT NULL DEFAULT '',
  summary text DEFAULT '',
  content text DEFAULT '',
  byte_size bigint DEFAULT 0,
  truncated boolean NOT NULL DEFAULT false,
  -- Hash of the FILE, not of the row. Two agents holding the same checkout
  -- produce the same hash, which is how the library can say "identical" without
  -- pulling both bodies down to compare them.
  content_hash text NOT NULL DEFAULT '',
  -- mtime on the agent's disk. The library ranks versions by this, falling back
  -- to last_synced: "newest" has to mean the newest FILE, not whichever daemon
  -- happened to reconnect most recently.
  source_modified_at timestamptz,
  last_synced timestamptz DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (agent_id, path)
);

CREATE INDEX IF NOT EXISTS idx_agent_documents_workspace_id ON agent_documents(workspace_id);
CREATE INDEX IF NOT EXISTS idx_agent_documents_agent_id ON agent_documents(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_documents_domain ON agent_documents(workspace_id, domain);
