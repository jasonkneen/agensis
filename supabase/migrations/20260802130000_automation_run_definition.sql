-- Freeze the validated automation definition onto each new run.
--
-- A worker can crash after committing one local side effect. The next claimant
-- resumes from automation_runs.steps, so it must see the same ordered steps as
-- the first claimant even when a human edited the automation in between.
-- Existing rows remain NULL and retain the pre-migration live-definition
-- fallback; no speculative backfill can recover what definition they saw.

ALTER TABLE automation_runs
  ADD COLUMN IF NOT EXISTS definition jsonb;
