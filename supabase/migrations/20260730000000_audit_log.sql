-- The audit log.
--
-- Before this table there was no durable record ANYWHERE of the actions that
-- most need one: workspace role changes, member removal, invite creation and
-- revocation, permission_mode flips to 'yolo' (unrestricted shell on the daemon
-- host), permanent tool-permission grants, connect-token minting, and vault
-- secret writes. All of them completed silently.
--
-- activity_events is not that record and cannot be made into one: it is written
-- by the browser through the generic /backend/db/insert route, the client
-- chooses its own event_type/title/user_id, and DB_TABLE_ACCESS grants
-- insert/update/delete at 'write'. Forgeable and erasable by design, which is
-- fine for a feed.
--
-- So audit_log is SERVER-WRITTEN ONLY. It is deliberately absent from
-- ALLOWED_TABLES in shared/backend-core.cjs, so ensureTable() rejects it before
-- any /backend/db/* handler runs and no realtime subscription can bind to it.
-- The only doors are recordAuditEntry (in) and the manage-gated
-- GET /backend/workspaces/:id/audit (out).
--
-- Tamper-EVIDENT against application-level actors, not tamper-PROOF: rows are
-- attested by the server rather than signed by the actor, and the app connects
-- as a role that can drop the trigger below.

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial NOT NULL,
  -- ON DELETE SET NULL, not CASCADE. Deleting a workspace is the most
  -- audit-worthy action there is; CASCADE would erase the evidence of it as a
  -- side effect of committing it. Hence nullable.
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  actor_user_id uuid,
  actor_agent_id uuid,
  actor_label text NOT NULL DEFAULT '',
  action text NOT NULL,
  target_type text NOT NULL DEFAULT '',
  target_id text,
  target_label text NOT NULL DEFAULT '',
  -- text, not jsonb: short scalars ('editor' -> 'admin', 'default' -> 'yolo'),
  -- so these cannot become the place someone dumps a whole row and its secrets.
  before_value text NOT NULL DEFAULT '',
  after_value text NOT NULL DEFAULT '',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_ip text NOT NULL DEFAULT '',
  -- SHA-256 over the row's canonical content. No prev_hash on purpose: a chain
  -- makes every write read the tail under a lock, on paths (role changes, token
  -- mints, secret writes) that must never stall, and proves nothing while the
  -- only available anchor is the same database the operator controls. This
  -- detects edits to a row; gaps in seq suggest deletion.
  entry_hash text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_workspace_created ON audit_log(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_action ON audit_log(action);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor_user_id);
CREATE UNIQUE INDEX IF NOT EXISTS uq_audit_log_seq ON audit_log(seq);

-- Append-only at the DB layer, below the API. Stops app bugs, an injection
-- reaching a DELETE, and a future contributor allowlisting the table without
-- thinking. Does not stop the DATABASE_URL holder; nothing here would.
CREATE OR REPLACE FUNCTION audit_log_refuse_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'audit_log rows are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  -- DELETE only past the retention horizon, so pruning never requires dropping
  -- this trigger by hand -- and a trigger dropped for maintenance stays off.
  IF OLD.created_at > now() - interval '400 days' THEN
    RAISE EXCEPTION 'audit_log rows younger than the retention horizon cannot be deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_audit_log_refuse_mutation ON audit_log;
CREATE TRIGGER trg_audit_log_refuse_mutation
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION audit_log_refuse_mutation();
