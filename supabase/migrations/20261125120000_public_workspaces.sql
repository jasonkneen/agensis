-- Public workspaces: workspaces.visibility (default private) and the per-event-type
-- publication policy. Written only by the manage-gated, audited routes in
-- server/public-workspace-routes.cjs.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'private';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_visibility_check' AND conrelid = 'workspaces'::regclass) THEN
    ALTER TABLE workspaces ADD CONSTRAINT workspaces_visibility_check CHECK (visibility IN ('private', 'public'));
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS workspace_public_policy (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  event_type text NOT NULL,
  level text NOT NULL DEFAULT 'private' CHECK (level IN ('public', 'members', 'private')),
  detail text NOT NULL DEFAULT 'category' CHECK (detail IN ('category', 'title', 'full')),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, event_type)
);
