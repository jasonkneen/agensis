/*
  # Inbox read state

  The inbox is a triage surface: it aggregates things that need a HUMAN out of
  five sources that already exist (thread_items blockers, the three comment
  tables, activity_events mentions, agent_jobs errors, and typed activity) and
  produces no rows of its own. Everything about it is derived EXCEPT read state,
  which is what this table holds.

  One marker per (user_id, workspace_id, context_key). An item is unread when
  its created_at is newer than the marker for its context_key, or when there is
  no marker at all — so a brand-new source row is unread by construction and no
  backfill is needed when a new category is added.

  Markers advance MONOTONICALLY. POST /backend/inbox/read upserts with a
  `WHERE inbox_read_state.read_at < excluded.read_at` guard, so a stale readAt
  (a slow request, or a second device that was behind) is a no-op rather than
  something that un-reads an item. That is what makes read state safe to sync
  across devices.

  context_key is deliberately text, not a FK: it namespaces across categories
  ('blocker:<uuid>', 'comment:<uuid>', 'thread:<uuid>', ...) and must survive the
  underlying row being deleted.

  The PRIMARY KEY doubles as the read-path index — the inbox query fetches
  markers by the (user_id, workspace_id) prefix, which the PK btree covers. The
  separate workspace_id index exists only to keep the ON DELETE CASCADE from
  workspaces cheap.
*/

CREATE TABLE IF NOT EXISTS inbox_read_state (
  user_id uuid NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  context_key text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id, context_key)
);

CREATE INDEX IF NOT EXISTS idx_inbox_read_state_workspace ON inbox_read_state(workspace_id);
