ALTER TABLE pending_cadence_wakes ADD COLUMN IF NOT EXISTS wake_id uuid NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE pending_cadence_wakes ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE pending_cadence_wakes ADD COLUMN IF NOT EXISTS lease_until timestamptz;
ALTER TABLE pending_cadence_wakes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;
ALTER TABLE pending_cadence_wakes ADD COLUMN IF NOT EXISTS failed_at timestamptz;
ALTER TABLE pending_cadence_wakes ADD COLUMN IF NOT EXISTS last_error text;
CREATE UNIQUE INDEX IF NOT EXISTS uq_agent_jobs_dispatch_wake ON agent_jobs ((metadata->>'dispatchWakeId')) WHERE metadata->>'dispatchWakeId' IS NOT NULL;
