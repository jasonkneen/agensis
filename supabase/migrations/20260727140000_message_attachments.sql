-- Real attachments on chat messages.
--
-- `attachments` holds REFERENCES to uploaded_files rows — [{id, name, type,
-- size}] — so the client can render an image inline and anything else as a
-- download chip. It never holds file bytes; the bytes stay in storage and are
-- served by the authenticated /backend/files/:id/content route.
--
-- Everything except `id` is client-supplied metadata and is treated as
-- untrusted at render time (src/lib/messageAttachments.ts).
--
-- This does NOT replace the human-readable "[Linked files]" block that the
-- composer folds into `content`: that text is still how an agent learns a file
-- came with the turn, and it is deliberately left in place.
--
-- Mirrors: server/index.cjs ensureRuntimeSchema, database/neon-schema.sql.
-- netlify/functions/backend.mjs carries no DDL for `messages` and needs none.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments jsonb DEFAULT '[]';
