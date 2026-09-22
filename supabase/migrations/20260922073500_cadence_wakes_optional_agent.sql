-- A social-channel cadence wake re-runs election; no agent is selected yet.
-- Keep the foreign key for pinned wakes, while allowing ordinary session wakes.
ALTER TABLE pending_cadence_wakes ALTER COLUMN agent_id DROP NOT NULL;
