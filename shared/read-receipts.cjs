'use strict';

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
// subscribe to its read state, and the fanout never has to know about privacy —
// the row only ever reaches a socket that already named the session and was
// allowed to. That is the same structural property that makes `messages` safe on
// the same lane, and it is the reason this table does NOT need an entry beside
// chat_sessions in the private-fanout split in server/realtime.cjs.
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
// $1 session id, $2 user id, $3 message id.
const ADVANCE_READ_MARKER_SQL = `insert into session_read_state (session_id, user_id, read_at)
select $1::uuid, $2::uuid, m.created_at
  from messages m
  join app_users u on u.id = $2::uuid
 where m.id = $3::uuid
   and m.session_id = $1::uuid
   and coalesce(u.share_read_receipts, true)
on conflict (session_id, user_id)
do update set read_at = excluded.read_at, updated_at = now()
 where session_read_state.read_at < excluded.read_at
returning session_id, user_id, read_at`;

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
// $1 session id, $2 the calling user's id.
const SESSION_READ_STATE_SQL = `select r.session_id, r.user_id, r.read_at
  from session_read_state r
  join app_users u on u.id = r.user_id
 where r.session_id = $1::uuid
   and coalesce(u.share_read_receipts, true)
   and exists (
     select 1 from app_users me
      where me.id = $2::uuid and coalesce(me.share_read_receipts, true)
   )
 order by r.read_at desc
 limit 500`;

// session_id leads the primary key because every read is "all markers for THIS
// session", and that prefix is covered by the PK btree — so no second index is
// created. The reverse direction (every session for one user) is not a query
// this feature makes; do not add the index speculatively.
const SESSION_READ_STATE_DDL = `
    CREATE TABLE IF NOT EXISTS session_read_state (
      session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      read_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz DEFAULT now(),
      PRIMARY KEY (session_id, user_id)
    );
`;

// Reciprocal by design (see SESSION_READ_STATE_SQL). Defaults to true: receipts
// are the product's normal behaviour and an opt-out that starts switched off is
// a feature nobody sees.
const SHARE_READ_RECEIPTS_DDL = `
    ALTER TABLE app_users ADD COLUMN IF NOT EXISTS share_read_receipts boolean NOT NULL DEFAULT true;
`;

function toReadMarker(row) {
 return {
  session_id: String(row.session_id),
  user_id: String(row.user_id),
  read_at: row.read_at instanceof Date ? row.read_at.toISOString() : String(row.read_at),
 };
}

module.exports = {
 ADVANCE_READ_MARKER_SQL,
 SESSION_READ_STATE_DDL,
 SESSION_READ_STATE_SQL,
 SHARE_READ_RECEIPTS_DDL,
 toReadMarker,
};
