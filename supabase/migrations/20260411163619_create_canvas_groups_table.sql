/*
  # Canvas groups for grouping shapes

  1. New Tables
    - `canvas_groups` - named groups of canvas objects
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk to workspaces)
      - `name` (text) - user-assigned group name
      - `color` (text) - display color for the group chip
      - `created_by` (uuid, fk to auth.users)
      - `created_at` (timestamptz)

  2. Modified Tables
    - `canvas_objects` - add `group_id` column (nullable uuid fk to canvas_groups)

  3. Security
    - RLS enabled on canvas_groups
    - Same workspace-member access pattern as other tables
*/

CREATE TABLE IF NOT EXISTS canvas_groups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT 'Untitled Group',
  color text NOT NULL DEFAULT '#3b82f6',
  created_by uuid REFERENCES auth.users(id),
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_groups_workspace_id ON canvas_groups(workspace_id);

ALTER TABLE canvas_groups ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view canvas groups"
  ON canvas_groups FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create canvas groups"
  ON canvas_groups FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can update canvas groups"
  ON canvas_groups FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can delete canvas groups"
  ON canvas_groups FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'canvas_objects' AND column_name = 'group_id'
  ) THEN
    ALTER TABLE canvas_objects ADD COLUMN group_id uuid REFERENCES canvas_groups(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_canvas_objects_group_id ON canvas_objects(group_id);

ALTER TABLE canvas_groups REPLICA IDENTITY FULL;
