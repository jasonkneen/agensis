-- Sandbox runtime: a third run_mode ('sandbox') whose provider + config live here.
-- run_mode has no CHECK constraint today (app-level enum), so no change needed there.
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_provider text;
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS sandbox_config jsonb NOT NULL DEFAULT '{}'::jsonb;
