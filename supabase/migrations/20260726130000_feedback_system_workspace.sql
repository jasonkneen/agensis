-- In-app feedback -> the System workspace.
--
-- Mirrors ensureRuntimeSchema (server/index.cjs) and database/neon-schema.sql;
-- all three must agree or a freshly provisioned database drifts from Fly.
--
-- A feedback report is an ORDINARY task in an ORDINARY workspace. The only new
-- concept is `workspaces.is_system`. Reuse buys the existing task list,
-- assignment, comments and agent dispatch with no parallel todo system.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- Singular by construction. Also what makes ensureSystemWorkspace race-safe
-- across Fly machines and Netlify lambdas: the loser of a concurrent create
-- hits this index, `on conflict do nothing` absorbs it, and it re-reads.
CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_system ON workspaces (is_system) WHERE is_system;

-- Postgres has no ALTER for a CHECK constraint, so drop + re-add. The name is
-- deterministic (Postgres names an inline column check `<table>_<column>_check`,
-- which is what the existing databases carry), so this is idempotent.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_type_check
  CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai', 'feedback'));

-- The bulky half of a report: console tail, captured errors, picked elements.
-- Deliberately NOT columns on `tasks` — task rows are fanned out over realtime
-- to every client in the workspace, and a few hundred console lines per row has
-- no business in that broadcast. `tasks.source_id` holds this row's id.
--
-- Read access is the generic /backend/db gate: feedback_reports is registered
-- workspace-scoped with select = 'read', so only members of the System
-- workspace can select it. Writes are gated to 'manage' so the only creator is
-- the dedicated, rate-limited POST /backend/feedback route.
CREATE TABLE IF NOT EXISTS feedback_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  reporter_id uuid REFERENCES app_users(id) ON DELETE SET NULL,
  -- The workspace the reporter was LOOKING AT, which is not the workspace the
  -- report lands in. Nullable and ON DELETE SET NULL: reports outlive it.
  source_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  description text NOT NULL DEFAULT '',
  page jsonb NOT NULL DEFAULT '{}'::jsonb,
  selections jsonb NOT NULL DEFAULT '[]'::jsonb,
  diagnostics jsonb,
  build_id text DEFAULT '',
  user_agent text DEFAULT '',
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_feedback_reports_workspace_id ON feedback_reports(workspace_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_task_id ON feedback_reports(task_id);
CREATE INDEX IF NOT EXISTS idx_feedback_reports_reporter_id ON feedback_reports(reporter_id);
