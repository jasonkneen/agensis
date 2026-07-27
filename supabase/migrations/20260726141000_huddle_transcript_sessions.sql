/*
  # Huddle transcript sessions — the huddle conversation leaves the channel

  A huddle is ad-hoc; the channel is the record. Until now speech-to-text was
  posted straight into the host channel or DM as ordinary messages, which turned
  a live voice call into permanent channel history — a dictation system nobody
  asked for.

  ## huddles.transcript_session_id

  The huddle gets its OWN conversation: a chat_sessions row created when the
  huddle starts, where the transcript and the agents' replies live. `session_id`
  still points at the channel/DM the huddle was CALLED FROM (it is what the
  toolbar button and the one-live-huddle-per-channel index key off); the new
  column points at the huddle's own session.

  A session rather than a new messages table or a messages.huddle flag, because
  chat_sessions already carries realtime, RBAC, history, threads, the composer
  and — the load-bearing one — agent dispatch. /backend/agents/dispatch resolves
  @mentions and the DM `direct: true` shortcut from the SESSION's participants,
  so the transcript session copies `participants` and `canvas_id` verbatim from
  its host and agents behave in the huddle exactly as they do in the channel.
  Its `folder` is 'huddle', which is what keeps it out of the sidebar: a huddle
  is reached from its channel's marker or its live card, never from the channel
  list.

  NULLABLE, and it stays that way. Huddles that ran before this migration have
  no transcript session, and their conversation genuinely did happen in the
  channel. Every reader falls back to session_id rather than treating the null
  as broken; there is deliberately no backfill.

  ON DELETE SET NULL rather than CASCADE: deleting a transcript session must not
  delete the record that the call took place.

  ## messages.huddle_id

  When a huddle ends, the host channel gets ONE unobtrusive marker row
  (message_kind='huddle', sender_kind='system') — "You were in a huddle" with
  the duration and who joined — instead of a replay of the conversation.
  huddle_id is what lets that row reopen the transcript months later, when the
  per-channel huddle lookup would answer with a completely different huddle.

  Exactly one marker per huddle: both end paths (the End button and LiveKit's
  room_finished webhook) write it only on the request whose
  `UPDATE ... WHERE ended_at IS NULL ... RETURNING` actually returned a row.

  No foreign key, on purpose. messages is created long before huddles, so an FK
  would need the deferred-ALTER dance chat_sessions.parent_message_id uses, and
  it would buy nothing: a marker whose huddle is gone degrades to a plain
  sentence with a dead link — the same graceful path an old huddle with no
  transcript session already takes. messages.sender_id stores an agent id with
  no FK for the same reason. The marker's `content` is a complete human-readable
  sentence, so a client that does not understand message_kind='huddle' still
  renders something true.
*/

ALTER TABLE huddles ADD COLUMN IF NOT EXISTS transcript_session_id uuid REFERENCES chat_sessions(id) ON DELETE SET NULL;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS huddle_id uuid;
CREATE INDEX IF NOT EXISTS idx_messages_huddle ON messages(huddle_id) WHERE huddle_id IS NOT NULL;
