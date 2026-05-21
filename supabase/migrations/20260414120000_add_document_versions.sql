/*
  # Document version history

  1. New Table
    - `document_versions` — immutable snapshots of document content
      - id, document_id, workspace_id, user_id
      - title, content, version_number
      - created_at

  2. Security
    - RLS enabled
    - Read/insert gated by existing is_workspace_accessible()
    - No update/delete (immutable snapshots)

  3. Notes
    - Cascades from both documents and workspaces
    - Indexes on (document_id, version_number DESC) and workspace_id
*/

-- ============================================================
-- DOCUMENT VERSIONS
-- ============================================================

CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  version_number integer NOT NULL DEFAULT 1,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_document_versions_doc_version ON document_versions(document_id, version_number DESC);
CREATE INDEX IF NOT EXISTS idx_document_versions_workspace_id ON document_versions(workspace_id);

ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members can view document versions"
  ON document_versions FOR SELECT
  TO authenticated
  USING (is_workspace_accessible(workspace_id));

CREATE POLICY "Members can create document versions"
  ON document_versions FOR INSERT
  TO authenticated
  WITH CHECK (is_workspace_accessible(workspace_id));
