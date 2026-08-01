-- A schedule without a target conversation cannot run or be authorized. Remove
-- legacy unusable rows before making that invariant structural.
DELETE FROM agent_schedules WHERE session_id IS NULL;

ALTER TABLE agent_schedules
  ALTER COLUMN session_id SET NOT NULL;
