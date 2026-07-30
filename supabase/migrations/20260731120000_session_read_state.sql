-- Read receipts.
--
-- The third of the three schema places (server/index.cjs ensureRuntimeSchema,
-- database/neon-schema.sql, here). The DDL itself is single-sourced in
-- shared/read-receipts.cjs and this file restates it so a database built from
-- migrations alone matches one built from a Fly boot.
--
-- ONE MONOTONIC high-water mark per (session, user): "I had this conversation on
-- screen up to this point". Not a row per message per user — that grows with
-- message volume times workspace size and is written on every scroll, where this
-- is bounded by (members x sessions) and coalesces a page of scrolling into one
-- write. It is also the more private of the two: it cannot record WHICH message
-- was read, only how far.
--
-- There is deliberately NO workspace_id column. It mirrors `messages`: without
-- one, an unscoped realtime subscription cannot be expressed at all, so a
-- client must filter by session_id — and that is what routes the read through
-- the DM gate. See shared/read-receipts.cjs.
--
-- session_id leads the primary key because every read is "all markers for THIS
-- session"; the PK btree covers that prefix, so no second index is created.
CREATE TABLE IF NOT EXISTS session_read_state (
  session_id uuid NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  read_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);

-- The RECIPROCAL opt-out: switching receipts off stops your marker being written
-- and stops you seeing anyone else's. Both halves are enforced in SQL
-- (shared/read-receipts.cjs), never by the UI declining to draw what it was
-- sent. Defaults to true.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS share_read_receipts boolean NOT NULL DEFAULT true;
