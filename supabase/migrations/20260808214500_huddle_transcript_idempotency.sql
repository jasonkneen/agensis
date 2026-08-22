-- Idempotent source event key for LiveKit huddle transcript ingestion.
-- NULL keeps legacy/non-huddle messages unaffected; huddle rows always send a key.
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS huddle_transcript_event_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_huddle_transcript_event
  ON messages(huddle_id, huddle_transcript_event_id);
