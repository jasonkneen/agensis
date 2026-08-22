-- Add reasoning effort level to agents
-- Allows per-agent configuration of inference effort (auto, low, medium, high, xhigh, max)
-- Maps to provider-specific reasoning effort parameters (e.g. Claude's thinking/budget_tokens)

ALTER TABLE workspace_agents
  ADD COLUMN effort text NOT NULL DEFAULT 'auto'
  CHECK (effort IN ('auto', 'low', 'medium', 'high', 'xhigh', 'max'));

-- Index for querying agents by effort level (useful for reporting/filtering)
CREATE INDEX IF NOT EXISTS idx_workspace_agents_effort ON workspace_agents(effort);
