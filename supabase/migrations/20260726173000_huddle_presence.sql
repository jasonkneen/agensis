/*
  # Huddle presence (liveness) — the server-side reaper for crashed browsers

  ## Why

  Huddle presence is SELF-REPORTED: the browser posts /confirm when its WebRTC
  session comes up and /leave when it goes away. That was necessary because
  LiveKit's webhook — the only other witness — needs a dashboard step that was
  never performed, and in 48 real huddles it delivered ZERO participant events,
  so every roster read "Waiting for the first person to connect" while someone
  was live and talking. The project's webhook has since been deleted outright.

  Self-reporting has the opposite failure: a browser that CRASHES, loses power
  or is force-quit never posts its /leave, and that participant stays in the
  roster forever. A huddle then shows people who are not there — the same
  "ghosts" complaint, arriving from the other direction.

  So presence must EXPIRE unless it is refreshed.

  ## The table

  One row per (huddle, identity), UPDATED IN PLACE — deliberately not part of
  huddle_events, which is append-only history that nothing may update. "Is this
  person still there" is a current value, not an event; appending a row per
  participant per heartbeat would grow the log without bound for no gain.

  Rows are deleted when the participant leaves and when the huddle ends, and
  cascade with the huddle. The table means "who is in a call right now"; who was
  EVER in it is the event log's question, and that log stays permanent.

  ## The columns, and the two clocks

  - last_seen_at  — seeded by /confirm, refreshed by every heartbeat. This is
    the "the room is not abandoned" clock the empty-huddle grace measures from.
  - heartbeat_at  — NULL until the client's FIRST heartbeat, and the ONLY thing
    the reaper keys on. A client that confirms but never beats is an OLDER
    FRONTEND: the app deploys to Netlify and this backend to Fly, independently,
    so a reaper that expired anyone who does not beat would empty every live
    huddle in the gap between the two deploys. Liveness is opt-in, per
    connection, by beating.
  - reaped_at     — stamped when the reaper expired the row. The next heartbeat
    sees it, re-announces the participant with a participant_joined and clears
    it, so a browser that was away longer than the window comes back to the
    roster instead of being live in the room and invisible on the card.
  - connection_epoch — which browser connection the row is about, so a reap and
    a rejoin by the same person cannot collide on an event id.

  ## The windows

  Heartbeat every 30s; presence goes stale after 150s. 150s is 2.5x the
  worst-case ONE-WAKE-PER-MINUTE clamp browsers apply to hidden tabs (Chrome's
  intensive throttling), so a participant who merely alt-tabs away has to miss
  two consecutive clamped wakes plus headroom before anything touches them. A
  foreground tab gets five attempts inside the window, so a run of failed posts
  on a flaky connection expires nobody.

  Reaping happens ON READ — in the huddle GETs, start-or-join, join-by-id and
  confirm — never on a timer. A ghost only exists when somebody looks, and a
  reaper that only works while a particular interval is alive is not one you can
  reason about across restarts, redeploys and multiple Fly machines.
*/

CREATE TABLE IF NOT EXISTS huddle_presence (
  huddle_id uuid NOT NULL REFERENCES huddles(id) ON DELETE CASCADE,
  identity text NOT NULL,
  connection_epoch text NOT NULL DEFAULT '',
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  heartbeat_at timestamptz,
  reaped_at timestamptz,
  PRIMARY KEY (huddle_id, identity)
);
