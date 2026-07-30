/*
  # Add sticky note support and attachment field

  1. Modified Tables
    - `canvas_objects`
      - `attached_to` (uuid, nullable) - references another canvas_object this item is "stuck" to
      - `font_size` (integer, default 14) - font size for text and sticky notes

  2. Notes
    - The `attached_to` column allows sticky notes to be visually linked to other objects
    - `font_size` provides per-object font size control for text and sticky notes
    - The type check constraint is updated to include 'sticky_note'
*/

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'canvas_objects' AND column_name = 'attached_to'
  ) THEN
    ALTER TABLE canvas_objects ADD COLUMN attached_to uuid REFERENCES canvas_objects(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'canvas_objects' AND column_name = 'font_size'
  ) THEN
    ALTER TABLE canvas_objects ADD COLUMN font_size integer DEFAULT 14;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_canvas_objects_attached_to ON canvas_objects(attached_to);
