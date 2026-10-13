-- Files attached to a project: uploaded_files.project_id, cleared if the project is deleted.
ALTER TABLE uploaded_files ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_uploaded_files_project_id ON uploaded_files(project_id);
