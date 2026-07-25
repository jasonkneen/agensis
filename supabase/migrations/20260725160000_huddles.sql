/*
  # Huddles — ad-hoc voice calls inside a channel, carried by LiveKit

  A huddle is a live voice room bound to the chat_sessions row it happened in,
  so the card renders in the real conversation rather than pointing at a
  separate, empty place.

  room_name is namespaced 'agensis-<huddleId>' because the LiveKit project is
  shared with other apps: the webhook receives rooms it does not own and must be
  able to tell them apart by name alone.

  idx_huddles_one_live_per_session is load-bearing, not an optimisation. Two
  people pressing "Huddle" in the same channel at the same moment must land in
  ONE room; the partial unique index is what decides that, and the losing insert
  falls in behind the winner (server/huddles.cjs catches 23505 and re-selects).

  huddle_events is APPEND-ONLY. Participant state is folded from the log
  (foldHuddleState) instead of being stored denormalised, which is what lets the
  card survive a reconnect and out-of-order webhook delivery with no
  reconciliation pass: a redelivered join is an idempotent Map.set, a
  redelivered leave an idempotent Map.delete, and a late event still lands in
  the right order because the fold sorts by the event's own timestamp rather
  than by arrival. Nothing may UPDATE or DELETE a row in this table.

  event_id is LiveKit's own event id. The partial unique index (skipping the ''
  used by app-generated 'started'/'ended' markers) makes a webhook redelivery a
  no-op at the database level rather than a duplicated participant.

  Authority is server-side: the browser can only ask for a token for ITSELF, and
  only when it is a member of the workspace that owns the session. Who was
  actually in the room comes from LiveKit's signed webhook.
*/

CREATE TABLE IF NOT EXISTS huddles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  room_name text NOT NULL UNIQUE,
  started_by uuid,
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_huddles_workspace_id ON huddles(workspace_id);
CREATE INDEX IF NOT EXISTS idx_huddles_session_started ON huddles(session_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_huddles_one_live_per_session ON huddles(session_id) WHERE ended_at IS NULL;

CREATE TABLE IF NOT EXISTS huddle_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  huddle_id uuid NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  kind text NOT NULL,
  identity text NOT NULL DEFAULT '',
  display_name text NOT NULL DEFAULT '',
  event_id text NOT NULL DEFAULT '',
  seq bigserial,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_huddle_events_huddle ON huddle_events(huddle_id, created_at, seq);
CREATE INDEX IF NOT EXISTS idx_huddle_events_session ON huddle_events(session_id, created_at, seq);
CREATE UNIQUE INDEX IF NOT EXISTS idx_huddle_events_event_id ON huddle_events(event_id) WHERE event_id <> '';
