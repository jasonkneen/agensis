/*
  # Task nesting (parent_id)

  Backfills the missing third place for `tasks.parent_id`. The column was only
  ever declared in `database/neon-schema.sql`; it had no migration and no entry
  in `ensureRuntimeSchema`, so a DB provisioned from migrations alone never got
  it. The MCP `create_task` / `update_task` tools now write `parent_id`, which
  would fail outright on such a DB.

  ON DELETE CASCADE: deleting a parent removes its whole subtree, which is why
  the MCP layer rejects cycles rather than trusting the caller's parent_id.
*/

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES tasks(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
