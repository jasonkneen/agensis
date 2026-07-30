/*
  # Scope chat sessions to a canvas layer (project)

  Adds chat_sessions.canvas_id so a session can belong to a specific canvas
  layer/project. Null = unassigned (shown in every project). Mirrors the
  existing canvas_objects.layer_id convention: a client-generated text id
  (e.g. 'base', 'canvas_...'), no foreign key.
*/

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS canvas_id text;
CREATE INDEX IF NOT EXISTS idx_chat_sessions_canvas ON chat_sessions(workspace_id, canvas_id);
