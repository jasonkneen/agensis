/*
  # Workspace-scoped canvas layers

  Layer ("project"/canvas) definitions used to live only in each browser's
  localStorage, while the objects drawn on them lived in the SHARED
  canvas_objects table keyed by that browser-generated layer id. A canvas one
  member created was therefore invisible to everyone else: their browser had no
  record of the layer, so it fell back to `base` and the shapes were unreachable.

  canvas_layers.layer_id is that same client-generated text id — the value
  canvas_objects.layer_id stores, 'base' for the default layer. The uuid `id`
  is the row's own primary key so every generic /backend/db row id stays
  globally unique (the RBAC gate resolves a row's workspace from a bare `id`
  filter, which a per-workspace text key would break). UNIQUE (workspace_id,
  layer_id) makes the client's adopt-existing-layers pass idempotent.

  Which layer is active stays per-browser in localStorage; only identity, name
  and ordering are shared.
*/

CREATE TABLE IF NOT EXISTS canvas_layers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  layer_id text NOT NULL,
  name text NOT NULL DEFAULT 'Workspace',
  sort_order double precision NOT NULL DEFAULT 0,
  description text DEFAULT '',
  icon text DEFAULT '',
  local_path text DEFAULT '',
  project_kind text DEFAULT '',
  git_root text DEFAULT '',
  git_remote text DEFAULT '',
  background_opacity double precision DEFAULT 0.42,
  background_image text DEFAULT '',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  UNIQUE (workspace_id, layer_id)
);

CREATE INDEX IF NOT EXISTS idx_canvas_layers_workspace_id ON canvas_layers(workspace_id);
