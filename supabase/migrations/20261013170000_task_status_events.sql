-- Task status history (project-management merge): one row per status change, written by a
-- trigger so every path (UI, agents, server) is recorded. Feeds the cumulative flow report.
CREATE TABLE IF NOT EXISTS task_status_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  from_status text,
  to_status text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_task_status_events_workspace ON task_status_events(workspace_id, changed_at);
CREATE INDEX IF NOT EXISTS idx_task_status_events_task ON task_status_events(task_id);
CREATE OR REPLACE FUNCTION log_task_status_change() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO task_status_events (workspace_id, task_id, from_status, to_status)
      VALUES (NEW.workspace_id, NEW.id, NULL, NEW.status);
  ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO task_status_events (workspace_id, task_id, from_status, to_status)
      VALUES (NEW.workspace_id, NEW.id, OLD.status, NEW.status);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_log_task_status_change ON tasks;
CREATE TRIGGER trg_log_task_status_change AFTER INSERT OR UPDATE OF status ON tasks
  FOR EACH ROW EXECUTE FUNCTION log_task_status_change();
