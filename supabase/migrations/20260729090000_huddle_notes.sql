-- Shared notes for a huddle call — the dock's Notes tab.
--
-- Plain text, not jsonb: there is no structure to a call's notes, just what
-- whoever was typing wrote. Written ONLY through the dedicated
-- POST /backend/workspaces/:id/huddles/:huddleId/notes route (gated to the
-- 'write' capability), never through the generic /backend/db path — that path
-- is 'manage'-only for `huddles` on purpose (see DB_TABLE_ACCESS.huddles in
-- shared/backend-core.cjs), because the row also carries LiveKit/webhook
-- authority an editor must never be able to touch. Notes are just words
-- anyone who could speak in the call could have said, so they get the same
-- bar as posting in the channel the huddle was called from.
--
-- Mirrors: server/huddles.cjs HUDDLES_SCHEMA_SQL, database/neon-schema.sql.
-- netlify/functions/backend.mjs carries no huddle DDL and needs none (see the
-- huddle_presence migration's note on why).

ALTER TABLE huddles ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT '';
