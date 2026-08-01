-- Keep resource records and their operation history while removing them from
-- normal workspace use. A dedicated delete route writes this marker; it never
-- physically deletes the resource or its steward-operation history.
ALTER TABLE workspace_resources
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_workspace_resources_deleted
  ON workspace_resources(workspace_id, deleted_at, created_at DESC);
