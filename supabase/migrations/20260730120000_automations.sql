-- Workspace automations.
--
-- The uncovered cell of agensis's trigger/action matrix. Three automation
-- systems already exist and each hardcodes one axis:
--
--   agent_schedules   time            -> wake an agent   (a paid model turn)
--   agent_webhooks    inbound HTTP    -> wake an agent   (a paid model turn)
--   flow_connections  workspace event -> POST to a URL   (outbound, external)
--
-- The one thing a user could not express without a code change is "when X
-- happens inside agensis, do Y inside agensis". That is this table.
--
-- The value is DETERMINISM, not authoring ergonomics: until now the only thing
-- in this product that could decide anything was a language model, so
-- "if a message here says 'deploy failed', post to #urgent" could not be made to
-- cost nothing and give the same answer every time. The evaluator in
-- shared/automation-rules.cjs is what buys that.
--
-- Definitions are stored as JSON, not YAML. YAML's coercions (`on:` -> true,
-- `no` -> false, an unquoted 1.0 -> float) do not throw; they produce a
-- different valid document that runs the wrong step. YAML is RENDERED for
-- reading and diffing and is never parsed back.

CREATE TABLE IF NOT EXISTS automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  -- OFF by default. A definition that starts live means the first thing a
  -- mistyped condition does is fire on everything, and the author finds out
  -- from the channel rather than from the form.
  enabled boolean NOT NULL DEFAULT false,
  -- Denormalised out of `definition` so the matcher's only query is a
  -- partial-index lookup, not a jsonb scan on every workspace write.
  trigger_event text NOT NULL,
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid,
  run_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_status text NOT NULL DEFAULT '',
  -- Set by the runaway guard. A tripped automation stays off until a human
  -- clears it; this column is why the UI can say why it stopped.
  disabled_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(workspace_id, trigger_event) WHERE enabled;

-- One row per (automation, triggering event). The queue AND the history.
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Stable per triggering row+version, the same shape as the flow webhook event
  -- id, so a retried write cannot enqueue the same run twice.
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  attempt_count integer NOT NULL DEFAULT 0,
  claim_token uuid,
  lease_expires_at timestamptz,
  -- The projected event the run saw, so a run stays readable after the source
  -- row has changed or been deleted.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Idempotent enqueue. This index IS the deduplication.
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_event ON automation_runs(automation_id, event_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_pending ON automation_runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace ON automation_runs(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_runs_recent ON automation_runs(automation_id, created_at DESC);
