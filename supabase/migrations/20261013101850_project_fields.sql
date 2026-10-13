-- Project fields from the approved New project dialog and landing page.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT 'folder';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS lead_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS start_date timestamptz;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS channel_id uuid;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS brief_document_id uuid;
