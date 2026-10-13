-- Project sharing: a private project is visible only to its creator and member_ids (people).
-- Task statuses widened from four to six: backlog and in_review join todo, in_progress, done, cancelled.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'workspace';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS member_ids uuid[] NOT NULL DEFAULT '{}';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_visibility_check' AND conrelid = 'projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_visibility_check CHECK (visibility IN ('workspace', 'private'));
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'tasks_status_check' AND conrelid = 'tasks'::regclass
      AND pg_get_constraintdef(oid) NOT LIKE '%in_review%'
  ) THEN
    ALTER TABLE tasks DROP CONSTRAINT tasks_status_check;
    ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
      CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done', 'cancelled'));
  END IF;
END $$;
