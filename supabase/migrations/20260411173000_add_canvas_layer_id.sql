/*
  # Add layer_id to canvas objects

  Enables multiple stacked canvases/floors within a workspace.
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'canvas_objects' AND column_name = 'layer_id'
  ) THEN
    ALTER TABLE canvas_objects ADD COLUMN layer_id text DEFAULT 'base';
  END IF;
END $$;

UPDATE canvas_objects
SET layer_id = 'base'
WHERE layer_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_canvas_objects_workspace_layer_id
  ON canvas_objects(workspace_id, layer_id);
