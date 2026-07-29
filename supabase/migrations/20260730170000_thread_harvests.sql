-- Suggestions: the stored proposals mined from a conversation.
--
-- The table is named thread_harvests and stays that way. The product calls this
-- "Suggestions" everywhere a person reads it (src/lib/suggestions.ts is the
-- boundary where the older word stops), but renaming a live table that two
-- backends read buys nothing a human can see, and a rename landing on one
-- deploy target before the other is an outage.
--
-- This migration exists because the table was only ever created by the runtime
-- bootstrap (ensureRuntimeSchema in server/index.cjs), so a database built from
-- migrations alone never had it. Same omission thread_items had.
--
-- Safe to run twice: every statement is IF NOT EXISTS, and the final DELETE
-- matches nothing on a second run.

CREATE TABLE IF NOT EXISTS thread_harvests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  reason text NOT NULL DEFAULT 'deleted',
  requested_by uuid,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- The watermark: the newest message a COMPLETED analysis of this conversation
-- has already considered. It is what makes a live conversation cheap to keep
-- mining — the next run reads only what has been said since, instead of the
-- whole channel from message 1. Added separately from the CREATE above so a
-- database that already has the table from the runtime bootstrap gets it too.
ALTER TABLE thread_harvests ADD COLUMN IF NOT EXISTS cursor_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_thread_harvests_pending ON thread_harvests(status, created_at);
CREATE INDEX IF NOT EXISTS idx_thread_harvests_workspace ON thread_harvests(workspace_id, created_at DESC);
-- Both halves of the idle sweep's per-conversation lookup: the watermark and
-- the cooldown are read together, once per candidate, every five minutes.
CREATE INDEX IF NOT EXISTS idx_thread_harvests_session ON thread_harvests(session_id, updated_at DESC);
-- One OPEN job per conversation: a double delete, or a race between two server
-- processes on the idle sweep, must cost one row rather than two model calls.
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_harvests_one_open
  ON thread_harvests(session_id) WHERE status IN ('pending', 'running');

-- No suggestion may EXIST for a private conversation.
--
-- Not a filter — a delete. The queue and the idle sweep both refuse to mine a
-- private conversation, but that only stops NEW rows: deleting a DM queued a
-- workspace-visible analysis before that rule existed. A suggestion is listed
-- to the whole workspace, so a proposal drawn out of somebody's DM would put
-- its contents in front of people who were never in it.
DELETE FROM thread_harvests h
 USING chat_sessions s
 WHERE s.id = h.session_id
   AND (COALESCE(s.visibility, 'workspace') = 'private'
        OR COALESCE(s.folder, '') = 'Direct messages');
