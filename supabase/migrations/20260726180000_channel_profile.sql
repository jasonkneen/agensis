-- Channel profile: a description, an icon, and an INTENT.
--
-- The intent is the interesting one. It is the channel owner's own description
-- of how people and agents should behave here ("a fun place to share stuff
-- that's not work related, joking is fine, clean language"), and it is injected
-- into every agent turn taken in this channel. That makes tone a property of
-- the ROOM rather than of the agent: the same agent is expected to be playful
-- in one channel and terse in another, and previously had no way to know which
-- it was standing in.
--
-- All three default to '' rather than NULL: every read path treats them as
-- plain strings, and a nullable text column would mean every caller guarding
-- for null before trimming.

ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS icon text NOT NULL DEFAULT '';
ALTER TABLE chat_sessions ADD COLUMN IF NOT EXISTS intent text NOT NULL DEFAULT '';
