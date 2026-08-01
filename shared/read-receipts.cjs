'use strict';

const { sessionReadableSql } = require('./backend-core.cjs');

// ----------------------------------------------------------------------------
// Read receipts — ONE implementation, both backends.
//
// THE DATA MODEL, and why it is not the obvious one
//
// The obvious model is a row per (message, reader). It is wrong by three orders
// of magnitude: 20 users x 200,000 messages is 4,000,000 rows, it grows with
// every message ever sent multiplied by the workspace size, and it is written on
// SCROLL — reading fifty messages would be fifty inserts.
//
// This is a per-(session, user) MONOTONIC HIGH-WATER MARK: "I had this
// conversation on screen up to this point". Rows are bounded by
// (members x sessions) — 20 users x 60 sessions is 1,200 rows — and a workspace
// that sends a million more messages adds ZERO of them. Scrolling past two
// hundred messages is ONE write, because the marker coalesces by construction
// rather than by a debounce timer.
//
// "Who read this message" is then derived in the client from at most one row per
// member:  readers(M) = { u : marker[u].read_at >= M.created_at } \ { M.author }.
//
// It is also the more private model, and that is a design property rather than a
// side effect: it can say "up to this point" and CANNOT say "they read that one
// and skipped the next", because that information is never recorded.
//
// NO workspace_id COLUMN, ON PURPOSE
//
// It mirrors `messages`. With no workspace column an unscoped subscription
// cannot be EXPRESSED: a client must filter by session_id, resolveOperationWorkspace
// resolves the tenant through chat_sessions, and enforceDbOperationAccess then
// runs enforceSessionReadAccess for that session. So a non-member of a DM cannot
// establish the subscription. Realtime still resolves the CURRENT session
// audience for each row: a socket that subscribed while a channel was public
// does not retain access after that channel becomes private.
//
// THE CLOCK
//
// The client never sends a timestamp. It sends the ID of the newest message it
// has seen, and the server resolves that to `messages.created_at`. Markers and
// message timestamps therefore come from ONE clock, so the whole browser-skew
// class disappears instead of being budgeted for — a receipt has no TTL to hide
// skew in, and a fast client clock would otherwise mark messages read that
// arrived after the reader left. (`inbox_read_state` accepts a client `readAt`
// because inbox triage is coarse and self-scoped; receipts are neither.)
// ----------------------------------------------------------------------------

// Advance one marker. The `where` on the upsert is the MONOTONIC guard, lifted
// from inbox_read_state where it is already proven: a marker can only ever move
// FORWARD, so a slow write from a second device cannot un-read something.
//
// The `m.session_id = $1` clause is not redundant with the route's own checks:
// without it a caller could name a message from a DIFFERENT session to plant a
// marker at an arbitrary point in time.
//
// `join app_users u ... and coalesce(u.share_read_receipts, true)` is the
// opt-out, enforced HERE rather than in the route body so it cannot be
// forgotten by the second lane. An opted-out reader's marker is never STORED,
// which is stronger than filtering it on the way out: there is nothing left
// behind to leak later, and no migration if the policy changes.
//
// $1 session id, $2 user id, $3 message id, $4 thread root (null = channel).
const ADVANCE_READ_MARKER_SQL = `with receipt_sharing_user as materialized (
 select sharing_user.id
   from app_users sharing_user
  where sharing_user.id = $2::uuid
    and coalesce(sharing_user.share_read_receipts, true)
  for share of sharing_user
),
readable_marker_session as materialized (
 select read_marker_session.id
   from chat_sessions read_marker_session
  where read_marker_session.id = $1::uuid
    and ${sessionReadableSql('read_marker_session', '$2', { lockMembership: true })}
  for share of read_marker_session
),
visible_marker_message as materialized (
 select m.id, m.created_at
   from messages m
   join readable_marker_session readable on readable.id = m.session_id
  where m.id = $3::uuid
    and m.deleted_at is null
    and (
      ($4::uuid is null and (m.thread_parent_id is null or m.broadcast_to_channel is true))
      or
      ($4::uuid is not null and (m.id = $4::uuid or m.thread_parent_id = $4::uuid))
    )
  for share of m
)
insert into session_read_state (
 session_id, user_id, thread_parent_id, last_seen_message_id, read_at
)
select $1::uuid, $2::uuid, $4::uuid, marker.id, marker.created_at
  from visible_marker_message marker
  join receipt_sharing_user sharing_user on true
on conflict (session_id, user_id, thread_parent_id) where user_id is not null
do update set
 last_seen_message_id = excluded.last_seen_message_id,
 read_at = excluded.read_at,
 event_version = nextval(pg_get_serial_sequence('session_read_state', 'event_version')),
 updated_at = now()
 where (session_read_state.read_at, session_read_state.last_seen_message_id)
     < (excluded.read_at, excluded.last_seen_message_id)
returning marker_id, event_version, session_id, user_id, agent_id, thread_parent_id,
          last_seen_message_id, read_at`;

// Switching receipts off is not just an output filter. Existing markers are
// deleted in the SAME transaction as the account setting so re-enabling starts
// empty and cannot resurrect an old social signal. Agent markers are a separate
// policy and remain untouched.
const DELETE_HUMAN_READ_MARKERS_SQL = `delete from session_read_state
 where user_id = $1::uuid
   and agent_id is null
 returning marker_id, event_version, session_id, user_id, agent_id, thread_parent_id,
           last_seen_message_id, read_at`;

// Advance an AGENT's marker to the newest message in the session it did NOT
// author. Agents are not in app_users, so their reader identity is agent_id
// (references workspace_agents) and there is no share_read_receipts opt-out to
// honour — an agent has no privacy interest of its own to protect, and "has this
// agent seen it" is the whole point of the feature.
//
// It resolves the message server-side rather than trusting a client-supplied id:
// the daemon feeds an agent its conversation out of band, so unlike the human
// path there is no "newest message on screen" to send. "Read up to the latest
// thing someone else said" is the truthful high-water mark for an agent turn.
//
// The caller supplies the exact message id that was present in the transcript
// delivered to the agent. Resolving "latest" here would race with new messages
// and would widen a thread-scoped read to the whole session. The row is still
// revalidated against the live session and agent participation in this single
// statement, so a revoke between context load and marker write fails closed.
//
// The sender predicate excludes the agent's own posts. `sender_kind` is part of
// the check so a human whose UUID happens to equal an agent UUID is not mistaken
// for that agent.
//
// `mcp_approved` is deliberately absent. It authorizes an external MCP control
// lane, not whether an enabled builtin agent in this session can observe the
// transcript the server has just loaded for it. Requiring it would suppress
// receipts for the default builtin configuration while the turn itself remains
// fully authorized to read and reply.
//
// $1 session id, $2 agent id, $3 exact message id actually delivered,
// $4 thread root (null = channel).
const ADVANCE_AGENT_READ_MARKER_SQL = `with readable_agent_session as materialized (
 select agent_session.id
   from chat_sessions agent_session
   join workspace_agents marker_agent
     on marker_agent.id = $2::uuid
    and marker_agent.workspace_id = agent_session.workspace_id
  where agent_session.id = $1::uuid
    and agent_session.deleted_at is null
    and marker_agent.enabled is not false
    and exists (
      select 1
        from jsonb_array_elements(coalesce(agent_session.participants, '[]'::jsonb)) participant
       where participant->>'kind' = 'agent'
         and participant->>'agent_id' = $2::text
    )
  for share of agent_session, marker_agent
),
visible_agent_marker as materialized (
 select m.session_id, m.created_at, m.id
   from messages m
   join readable_agent_session readable on readable.id = m.session_id
  where m.id = $3::uuid
    and m.deleted_at is null
    and (
      ($4::uuid is null and (m.thread_parent_id is null or m.broadcast_to_channel is true))
      or
      ($4::uuid is not null and (m.id = $4::uuid or m.thread_parent_id = $4::uuid))
    )
    and not (
      coalesce(m.sender_kind, '') = 'agent'
      and coalesce(m.sender_id::text, '') = $2::text
    )
 for share of m
)
insert into session_read_state (
 session_id, agent_id, thread_parent_id, last_seen_message_id, read_at
)
select marker.session_id, $2::uuid, $4::uuid, marker.id, marker.created_at
  from visible_agent_marker marker
on conflict (session_id, agent_id, thread_parent_id) where agent_id is not null
do update set
 last_seen_message_id = excluded.last_seen_message_id,
 read_at = excluded.read_at,
 event_version = nextval(pg_get_serial_sequence('session_read_state', 'event_version')),
 updated_at = now()
 where (session_read_state.read_at, session_read_state.last_seen_message_id)
     < (excluded.read_at, excluded.last_seen_message_id)
returning marker_id, event_version, session_id, user_id, agent_id, thread_parent_id,
          last_seen_message_id, read_at`;

// Every marker for one session, minus the people who have opted out.
//
// RECIPROCITY: the caller's own flag is in the WHERE too, so switching receipts
// off also stops you SEEING other people's. That is what keeps the setting from
// being a one-way mirror — the cost of hiding is symmetric — and it is enforced
// server-side rather than by the UI declining to draw what it was sent.
//
// `updated_at` is deliberately NOT projected. It records when the marker last
// MOVED, which is a second and finer clock than the one this feature means to
// disclose; it stays an operational column.
//
// A marker's reader is a human (user_id) OR an agent (agent_id); the projection
// collapses the two columns into one opaque `reader_id` plus a `reader_kind` so
// the client resolves a name the same way for both and never has to know which
// column a row came from. `left join` (not `join`) because an agent row has no
// app_users match; its opt-out clause is skipped since agents have no
// share_read_receipts flag. The caller-reciprocity `exists (...)` still gates the
// WHOLE result: a human who switched receipts off sees nobody's eye, human or
// agent, which keeps the setting symmetric.
//
// $1 session id, $2 the calling user's id, $3 thread root (null = channel).
const SESSION_READ_STATE_SQL = `with readable_state_session as materialized (
 select read_state_session.id
   from chat_sessions read_state_session
  where read_state_session.id = $1::uuid
    and ${sessionReadableSql('read_state_session', '$2', { lockMembership: true })}
  for share of read_state_session
)
select r.marker_id,
       r.event_version,
       r.session_id,
       coalesce(r.user_id, r.agent_id) as reader_id,
       case when r.agent_id is not null then 'agent' else 'human' end as reader_kind,
       r.thread_parent_id,
       r.last_seen_message_id,
       r.read_at
  from session_read_state r
  join readable_state_session readable on readable.id = r.session_id
  left join app_users u on u.id = r.user_id
 where r.session_id = $1::uuid
   and r.thread_parent_id is not distinct from $3::uuid
   and (r.agent_id is not null or coalesce(u.share_read_receipts, true))
   and exists (
     select 1 from app_users me
      where me.id = $2::uuid and coalesce(me.share_read_receipts, true)
   )
 order by r.read_at desc
 limit 500`;

// session_id leads the unique indexes because the normal read is "all markers
// for THIS session". Opt-out is the deliberate reverse lookup: delete every
// human marker for one user inside the profile transaction. A separate partial
// user_id index keeps that operation from becoming a full-table scan at scale.
//
// A reader is EITHER a human (user_id -> app_users) or an agent (agent_id ->
// workspace_agents), never both and never neither — the CHECK enforces exactly
// one, and two PARTIAL unique indexes give each kind its own "one marker per
// (session, reader)" guarantee. There is no plain PRIMARY KEY any more because a
// PK column cannot be null and each reader column is null for the other kind.
//
// This constant is ONE statement on purpose. ensureRuntimeSchema runs each DDL
// string through a single db.unsafe(), which postgres.js sends on the extended
// (prepared) protocol — and that protocol rejects a string carrying more than one
// command ("cannot insert multiple commands into a prepared statement"), which
// would throw at boot before the server ever listens. The in-place UPGRADE for a
// table still on the old (session_id, user_id) shape is therefore a LIST of
// single statements, applied one db.unsafe() at a time by ensureSessionReadStateShape.
const SESSION_READ_STATE_DDL = `
    CREATE TABLE IF NOT EXISTS session_read_state (
      marker_id uuid NOT NULL DEFAULT gen_random_uuid(),
      event_version bigint GENERATED BY DEFAULT AS IDENTITY,
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      user_id uuid REFERENCES app_users(id) ON DELETE CASCADE,
      agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE,
      thread_parent_id uuid REFERENCES messages(id) ON DELETE CASCADE,
      last_seen_message_id uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      read_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      CONSTRAINT session_read_state_marker_id_key UNIQUE (marker_id),
      CONSTRAINT session_read_state_one_reader CHECK ((user_id IS NOT NULL) <> (agent_id IS NOT NULL))
    )
`;

// Idempotent upgrade steps for a database whose session_read_state predates
// agent readers. Each entry is a SINGLE statement (see the note above). Order is
// load-bearing: the PK (session_id, user_id) must be DROPPED before user_id can
// have its NOT NULL removed — Postgres refuses "DROP NOT NULL" on a column that
// is still part of a primary key ("column is in a primary key"), which a mocked
// DB cannot reproduce and a real one does. So drop the PK, then widen user_id,
// then add the CHECK (guarded — old rows all satisfy it) and the partial unique
// indexes that stand in for the dropped PK.
const SESSION_READ_STATE_UPGRADE_STEPS = [
 `ALTER TABLE session_read_state ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE`,
 `ALTER TABLE session_read_state ADD COLUMN IF NOT EXISTS thread_parent_id uuid REFERENCES messages(id) ON DELETE CASCADE`,
 `ALTER TABLE session_read_state ADD COLUMN IF NOT EXISTS marker_id uuid DEFAULT gen_random_uuid()`,
 `ALTER TABLE session_read_state ALTER COLUMN marker_id SET NOT NULL`,
 `ALTER TABLE session_read_state ADD CONSTRAINT session_read_state_marker_id_key UNIQUE (marker_id)`,
 `ALTER TABLE session_read_state ADD COLUMN IF NOT EXISTS event_version bigint GENERATED BY DEFAULT AS IDENTITY`,
 `ALTER TABLE session_read_state ADD COLUMN IF NOT EXISTS last_seen_message_id uuid REFERENCES messages(id) ON DELETE CASCADE`,
 `ALTER TABLE session_read_state DROP CONSTRAINT IF EXISTS session_read_state_pkey`,
 `ALTER TABLE session_read_state ALTER COLUMN user_id DROP NOT NULL`,
 `ALTER TABLE session_read_state ADD CONSTRAINT session_read_state_one_reader CHECK ((user_id IS NOT NULL) <> (agent_id IS NOT NULL))`,
 `UPDATE session_read_state receipt SET last_seen_message_id = (
    SELECT candidate.id
      FROM messages candidate
     WHERE candidate.session_id = receipt.session_id
       AND candidate.created_at <= receipt.read_at
       AND (
         (receipt.thread_parent_id IS NULL
          AND (candidate.thread_parent_id IS NULL OR candidate.broadcast_to_channel IS TRUE))
         OR
         (receipt.thread_parent_id IS NOT NULL
          AND (candidate.id = receipt.thread_parent_id
               OR candidate.thread_parent_id = receipt.thread_parent_id))
       )
     ORDER BY candidate.created_at DESC, candidate.id ASC
     LIMIT 1
  ) WHERE receipt.last_seen_message_id IS NULL`,
 `DELETE FROM session_read_state WHERE last_seen_message_id IS NULL`,
 `ALTER TABLE session_read_state ALTER COLUMN last_seen_message_id SET NOT NULL`,
 `CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_user_scope_uidx ON session_read_state (session_id, user_id, thread_parent_id) NULLS NOT DISTINCT WHERE user_id IS NOT NULL`,
 `CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_agent_scope_uidx ON session_read_state (session_id, agent_id, thread_parent_id) NULLS NOT DISTINCT WHERE agent_id IS NOT NULL`,
 `DROP INDEX IF EXISTS session_read_state_user_uidx`,
 `DROP INDEX IF EXISTS session_read_state_agent_uidx`,
 `CREATE INDEX IF NOT EXISTS session_read_state_user_lookup_idx ON session_read_state (user_id) WHERE user_id IS NOT NULL`,
 `CREATE INDEX IF NOT EXISTS session_read_state_agent_lookup_idx ON session_read_state (agent_id) WHERE agent_id IS NOT NULL`,
];

// Create the table, then apply each upgrade step. Steps are individually
// best-effort: every one is written to be a no-op on an already-current table
// (IF NOT EXISTS / IF EXISTS / an already-nullable column), and the single
// exception — ADD CONSTRAINT, which has no IF NOT EXISTS form — is swallowed only
// for the "already exists" (duplicate_object, 42710) case so a second boot does
// not crash on it. Any other error still propagates, because a DDL failure we did
// not anticipate must not be hidden.
async function ensureSessionReadStateShape(db) {
 await db.unsafe(SESSION_READ_STATE_DDL);
 for (const step of SESSION_READ_STATE_UPGRADE_STEPS) {
  try {
   await db.unsafe(step);
  } catch (error) {
   if (error && (error.code === '42710' || error.code === '42P07')) continue; // duplicate object/table
   throw error;
  }
 }
}

// Reciprocal by design (see SESSION_READ_STATE_SQL). Defaults to true: receipts
// are the product's normal behaviour and an opt-out that starts switched off is
// a feature nobody sees.
const SHARE_READ_RECEIPTS_DDL = `
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS share_read_receipts boolean NOT NULL DEFAULT true;
`;

// Normalise a marker row to one wire shape regardless of which path produced it:
// the /read-state SELECT already projects `reader_id`/`reader_kind`, while an
// ADVANCE ... returning row carries the raw `user_id`/`agent_id` columns. Both
// collapse to a single opaque reader id so the client treats a human and an agent
// identically — it only ever needs "who, and what name".
function toReadMarker(row) {
 const readerId = row.reader_id != null ? row.reader_id
  : row.user_id != null ? row.user_id
  : row.agent_id;
 const readerKind = row.reader_kind != null ? String(row.reader_kind)
  : row.agent_id != null ? 'agent' : 'human';
 return {
  session_id: String(row.session_id),
  marker_id: String(row.marker_id),
  event_version: String(row.event_version || '0'),
  reader_id: String(readerId),
  reader_kind: readerKind,
  thread_parent_id: row.thread_parent_id == null ? null : String(row.thread_parent_id),
  last_seen_message_id: String(row.last_seen_message_id),
  read_at: row.read_at instanceof Date ? row.read_at.toISOString() : String(row.read_at),
 };
}

module.exports = {
 ADVANCE_READ_MARKER_SQL,
 ADVANCE_AGENT_READ_MARKER_SQL,
 DELETE_HUMAN_READ_MARKERS_SQL,
 SESSION_READ_STATE_DDL,
 SESSION_READ_STATE_UPGRADE_STEPS,
 ensureSessionReadStateShape,
 SESSION_READ_STATE_SQL,
 SHARE_READ_RECEIPTS_DDL,
 toReadMarker,
};
