/*
  # Canvas objects table for collaborative whiteboard

  1. New Tables
    - `canvas_objects` - stores all drawable objects on the workspace canvas
      - `id` (uuid, pk)
      - `workspace_id` (uuid, fk to workspaces)
      - `user_id` (uuid, fk to auth.users) - who created it
      - `type` (text) - shape type: rect, ellipse, diamond, arrow, line, pen, text, image, video, file
      - `x` (float) - position X as percentage of canvas width
      - `y` (float) - position Y as percentage of canvas height
      - `width` (float) - width as percentage
      - `height` (float) - height as percentage
      - `rotation` (float) - rotation in degrees
      - `fill` (text) - fill color
      - `stroke` (text) - stroke color
      - `stroke_width` (float) - stroke width in px
      - `opacity` (float) - 0 to 1
      - `points` (jsonb) - for pen strokes, array of {x, y} points
      - `text_content` (text) - for text objects
      - `src` (text) - for image/video/file objects, URL or storage path
      - `file_name` (text) - original file name for uploads
      - `z_index` (integer) - layer ordering
      - `locked` (boolean) - whether object is locked from editing
      - `created_at` (timestamptz)
      - `updated_at` (timestamptz)

  2. Security
    - RLS enabled on canvas_objects
    - Workspace owners and members can CRUD canvas objects

  3. Notes
    - Positions and sizes stored as percentages for responsive canvas
    - Pen strokes stored as JSONB point arrays
    - Real-time sync handled via Supabase Realtime subscriptions
*/

CREATE TABLE IF NOT EXISTS canvas_objects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  type text NOT NULL DEFAULT 'rect' CHECK (type IN ('rect', 'ellipse', 'diamond', 'arrow', 'line', 'pen', 'text', 'image', 'video', 'file')),
  x float NOT NULL DEFAULT 50,
  y float NOT NULL DEFAULT 50,
  width float NOT NULL DEFAULT 10,
  height float NOT NULL DEFAULT 10,
  rotation float NOT NULL DEFAULT 0,
  fill text NOT NULL DEFAULT '#4f9cf9',
  stroke text NOT NULL DEFAULT 'transparent',
  stroke_width float NOT NULL DEFAULT 2,
  opacity float NOT NULL DEFAULT 1,
  points jsonb DEFAULT '[]',
  text_content text DEFAULT '',
  src text DEFAULT '',
  file_name text DEFAULT '',
  z_index integer NOT NULL DEFAULT 0,
  locked boolean NOT NULL DEFAULT false,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_canvas_objects_workspace_id ON canvas_objects(workspace_id);

ALTER TABLE canvas_objects ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view canvas objects"
  ON canvas_objects FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create canvas objects"
  ON canvas_objects FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can update canvas objects"
  ON canvas_objects FOR UPDATE
  TO authenticated
  USING (is_workspace_accessible(workspace_id))
  WITH CHECK (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can delete canvas objects"
  ON canvas_objects FOR DELETE
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

ALTER TABLE canvas_objects REPLICA IDENTITY FULL;
