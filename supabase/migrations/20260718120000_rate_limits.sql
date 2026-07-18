-- Cross-instance rate limiting (H4 follow-up).
-- The in-memory createRateLimiter only bounds a single warm process; on Fly
-- (multi-machine) and Netlify (multi-lambda) each instance had its own counter,
-- so the effective limit was N x the intended budget. This table backs the
-- shared createDbRateLimiter: one atomic fixed-window counter every instance
-- increments.
--
-- Fixed-window model: a row per (bucket, window_start). window_start is the
-- floored window boundary, so each window is its own immutable row and old
-- windows are swept rather than mutated — no reset_at race.

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);

-- Sweep support: delete windows older than the retention cutoff efficiently.
CREATE INDEX IF NOT EXISTS idx_rate_limits_window_start ON rate_limits (window_start);
