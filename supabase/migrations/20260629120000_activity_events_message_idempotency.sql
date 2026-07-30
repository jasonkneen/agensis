-- C3 — Activity logging idempotency.
-- A message INSERT spawns a companion 'message_sent' activity_events row. Retried
-- daemon finalizations (the finalizing UPDATE re-runs the logger for the same
-- message id) could previously duplicate that feed row. A partial UNIQUE index on
-- the message entity id makes the logging insert idempotent via ON CONFLICT DO
-- NOTHING.

-- Collapse any pre-existing duplicates (keep the earliest row per message) so the
-- unique index can be created.
DELETE FROM activity_events a
USING activity_events b
WHERE a.event_type = 'message_sent'
  AND a.entity_type = 'message'
  AND b.event_type = 'message_sent'
  AND b.entity_type = 'message'
  AND a.entity_id IS NOT NULL
  AND a.entity_id = b.entity_id
  AND a.ctid > b.ctid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_activity_events_message_sent
  ON activity_events (entity_id)
  WHERE event_type = 'message_sent' AND entity_type = 'message';
