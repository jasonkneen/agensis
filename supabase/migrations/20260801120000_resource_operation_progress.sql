-- Durable, lease-bound checkpoints for agent-stewarded resource operations.
-- The resource-operation tables remain dedicated surfaces: this is not a
-- generic DB/realtime allowlist change.
ALTER TABLE resource_operations
  ADD COLUMN IF NOT EXISTS progress jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS progress_seq bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS progress_updated_at timestamptz;

ALTER TABLE resource_operations
  DROP CONSTRAINT IF EXISTS resource_operations_progress_object_check;
ALTER TABLE resource_operations
  ADD CONSTRAINT resource_operations_progress_object_check
  CHECK (jsonb_typeof(progress) = 'object');

ALTER TABLE resource_operations
  DROP CONSTRAINT IF EXISTS resource_operations_progress_seq_check;
ALTER TABLE resource_operations
  ADD CONSTRAINT resource_operations_progress_seq_check
  CHECK (progress_seq >= 0);
