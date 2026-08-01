-- Account opt-out deletes every human read marker for one user. The existing
-- unique index starts with session_id and cannot efficiently serve that reverse
-- lookup, so keep the delete indexed without adding agent rows to the index.

CREATE INDEX IF NOT EXISTS session_read_state_user_lookup_idx
  ON session_read_state (user_id)
  WHERE user_id IS NOT NULL;
