-- DM read scope: read authorization gains a second granularity below the workspace.
--
-- Before this, every workspace member holding `read` could read every session in
-- the workspace, including other people's Direct messages — scoping happened
-- because the SQL narrowed to the session the caller asked for, not because a
-- permission said they may see it.
--
-- Mirrors server/index.cjs ensureRuntimeSchema and database/neon-schema.sql.

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace';
CREATE INDEX IF NOT EXISTS idx_chat_sessions_visibility ON chat_sessions(workspace_id, visibility);

-- Deliberately absent from ALLOWED_TABLES in shared/backend-core.cjs: reachable
-- through POST /backend/db/insert this table would be a self-grant primitive.
CREATE TABLE IF NOT EXISTS chat_session_members (
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'participant',
  granted_by uuid,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_session_members_user ON chat_session_members(user_id);

-- Backfill: DMs are private, and their owner is the workspace owner. See the
-- long comment in server/index.cjs for why the owner is a restoration of
-- existing access rather than a guess.
UPDATE chat_sessions SET visibility = 'private'
 WHERE folder = 'Direct messages' AND visibility <> 'private';

INSERT INTO chat_session_members (session_id, user_id, source)
SELECT s.id, w.user_id, 'participant'
  FROM chat_sessions s
  JOIN workspaces w ON w.id = s.workspace_id
 WHERE s.visibility = 'private'
   AND w.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM chat_session_members m WHERE m.session_id = s.id)
ON CONFLICT DO NOTHING;

-- Anything derived from a private session inherits its privacy: sub-threads,
-- splits, huddle transcripts.
WITH RECURSIVE edges AS (
  SELECT c.id AS child, c.split_parent_id AS parent
    FROM chat_sessions c WHERE c.split_parent_id IS NOT NULL
  UNION ALL
  SELECT c.id, m.session_id
    FROM chat_sessions c JOIN messages m ON m.id = c.parent_message_id
  UNION ALL
  SELECT h.transcript_session_id, h.session_id
    FROM huddles h
   WHERE h.transcript_session_id IS NOT NULL AND h.session_id IS NOT NULL
), lineage AS (
  SELECT id FROM chat_sessions WHERE visibility = 'private'
  UNION
  SELECT e.child FROM edges e JOIN lineage l ON e.parent = l.id
)
UPDATE chat_sessions s SET visibility = 'private'
  FROM lineage l
 WHERE s.id = l.id AND s.visibility <> 'private';

INSERT INTO chat_session_members (session_id, user_id, source)
SELECT s.id, w.user_id, 'participant'
  FROM chat_sessions s
  JOIN workspaces w ON w.id = s.workspace_id
 WHERE s.visibility = 'private'
   AND w.user_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM chat_session_members m WHERE m.session_id = s.id)
ON CONFLICT DO NOTHING;
