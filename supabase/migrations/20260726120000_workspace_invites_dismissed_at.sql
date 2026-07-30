/*
  # Dismiss spent invite links

  The invite-link list only grows. Every link you ever made stays in it, and a
  revoked one is finished business that still takes a full row forever — so the
  more you use invites, the harder the list is to read.

  `dismissed_at` is a SOFT delete for the list. NULL = shown; a timestamp means
  the row has been tidied away and only appears under "Show dismissed". Nothing
  is deleted, ever: an accepted invite is the record of how a member got into
  the workspace, and its accepted_by / accepted_at have to outlive someone
  clearing the list.

  Only a SPENT link may be dismissed — revoked, accepted, or a still-pending one
  past `expires_at`. An ACTIVE link must not be hideable: the link would keep
  granting access while disappearing from the only surface that lists it. The
  routes carry that predicate in SQL (server/index.cjs, PATCH + POST
  .../invites/dismiss-spent), and src/lib/inviteDismissal.ts holds the matching
  client-side rule so the UI never offers the action.

  This migration also CREATEs workspace_invites. The table previously existed
  only in the runtime bootstrap (ensureRuntimeSchema in server/index.cjs) and in
  neither database/neon-schema.sql nor any migration, so a DB built from
  migrations alone had no invites table at all. The definition below matches the
  runtime DDL; both statements are idempotent, so this is a no-op on a database
  the bootstrap has already touched.
*/

CREATE TABLE IF NOT EXISTS workspace_invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  email text DEFAULT '',
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('admin', 'editor', 'commenter', 'viewer')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked')),
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  accepted_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  accepted_at timestamptz,
  expires_at timestamptz,
  dismissed_at timestamptz,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE workspace_invites ADD COLUMN IF NOT EXISTS dismissed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_workspace_invites_workspace_id ON workspace_invites(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invites_token ON workspace_invites(token);
