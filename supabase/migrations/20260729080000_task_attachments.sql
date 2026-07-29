-- Real attachments on tasks.
--
-- Same shape and same rules as messages.attachments (20260727140000): a
-- jsonb array of REFERENCES to uploaded_files rows — [{id, name, type,
-- size}] — never file bytes. The client renders an image inline and
-- anything else as a download chip, served by the authenticated
-- /backend/files/:id/content route. Everything except `id` is
-- client-supplied and treated as untrusted at render time
-- (src/lib/messageAttachments.ts — reused as-is; the shape is generic).
--
-- Mirrors: server/index.cjs ensureRuntimeSchema, database/neon-schema.sql.
-- netlify/functions/backend.mjs carries no DDL for `tasks` and needs none.

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS attachments jsonb NOT NULL DEFAULT '[]'::jsonb;
