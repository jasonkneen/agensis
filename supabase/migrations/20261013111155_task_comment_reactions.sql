-- Emoji reactions on task comments: { "👍": ["<user id>", ...], ... }. Empty by default.
ALTER TABLE task_comments ADD COLUMN IF NOT EXISTS reactions jsonb NOT NULL DEFAULT '{}'::jsonb;
