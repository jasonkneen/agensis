-- Cost metering: one row per paid provider call.
--
-- Counts only — tokens, characters or seconds (`unit` says which) — plus the
-- provider and the resource billed. NEVER a price. Rates move, and a price
-- written into a row on the day of the call becomes a lie indistinguishable
-- from a current figure. Money is computed at display time from
-- shared/usage-rates.cjs, the single place a rate may be edited.
--
-- All scalar columns, no jsonb: this table cannot reproduce the bind bug where
-- the Fly lane needs an object and the Netlify lane needs the string.
--
-- workspace_id is ON DELETE SET NULL, not CASCADE: deleting a workspace must
-- not delete the record of what it cost. Such a row leaves the per-account
-- rollup and stays in the deployment total.
--
-- Mirrors ensureRuntimeSchema in server/index.cjs and database/neon-schema.sql.

CREATE TABLE IF NOT EXISTS usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL,
  provider text NOT NULL,
  resource text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT '',
  unit text NOT NULL DEFAULT 'tokens',
  input_units bigint NOT NULL DEFAULT 0,
  output_units bigint NOT NULL DEFAULT 0,
  cache_write_units bigint NOT NULL DEFAULT 0,
  cache_read_units bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_usage_events_workspace_created ON usage_events(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_created ON usage_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_created ON usage_events(provider, created_at DESC);

-- The metering epoch. No usage exists before this row, none can be
-- back-filled, and every cost figure in the UI is labelled "since" this date so
-- a total is never mistaken for an all-time one.
INSERT INTO app_settings (key, value)
     VALUES ('usage.metering_started_at', now()::text)
ON CONFLICT (key) DO NOTHING;
