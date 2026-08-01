-- Preserve the assigning human across a queued agent dispatch.
--
-- This is server-owned routing provenance, not editable task content. A task
-- may be created by one human and assigned by another; using created_by after a
-- queue delay sends the eventual agent turn into the wrong private DM.
ALTER TABLE tasks
  ADD COLUMN IF NOT EXISTS dispatch_requested_by uuid;

COMMENT ON COLUMN tasks.dispatch_requested_by IS
  'Server-owned human whose per-human agent DM receives a delayed assignment; never client-authored.';
