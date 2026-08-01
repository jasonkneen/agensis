-- Messages have many trusted producers (built-in and daemon turns, MCP,
-- automations, huddles and bridges). Keep the closed-conversation invariant at
-- the database boundary so one producer cannot resurrect a deleted transcript.
--
-- INSERT takes a SHARE lock on the target session. It therefore either commits
-- before a concurrent clear (and is tombstoned by it) or waits until the clear
-- commits and is rejected. UPDATE cannot move a message between sessions and
-- cannot change a tombstone.

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS split_baseline_message_id uuid;

ALTER TABLE chat_sessions
  ADD COLUMN IF NOT EXISTS split_source_boundary_message_id uuid;

CREATE OR REPLACE FUNCTION messages_require_live_session()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.session_id IS DISTINCT FROM OLD.session_id THEN
      RAISE EXCEPTION 'A message cannot move between conversations'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'messages_live_session_write_guard';
    END IF;
    IF OLD.deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'A deleted message is immutable'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'messages_live_session_write_guard';
    END IF;
    PERFORM 1
      FROM chat_sessions
     WHERE id = NEW.session_id
       AND deleted_at IS NULL;
  ELSE
    PERFORM 1
      FROM chat_sessions
     WHERE id = NEW.session_id
       AND deleted_at IS NULL
     FOR SHARE;
    IF FOUND THEN
      NEW.created_at = clock_timestamp();
    END IF;
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Messages require a live conversation'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'messages_live_session_write_guard';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_messages_require_live_session ON messages;
CREATE TRIGGER trg_messages_require_live_session
  BEFORE INSERT OR UPDATE ON messages
  FOR EACH ROW EXECUTE FUNCTION messages_require_live_session();
