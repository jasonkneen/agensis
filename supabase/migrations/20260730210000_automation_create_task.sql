-- ---------------------------------------------------------------------------
-- The automations `create_task` action needs one thing from the schema: a
-- `tasks.source_type` of 'automation'.
--
-- SAFE TO RUN TWICE, and safe on a populated table. Two separate properties:
--
--   Idempotent. Postgres has no ALTER for a CHECK, so the constraint is
--   dropped and re-added. DROP ... IF EXISTS makes the first half a no-op on a
--   re-run, and the name is deterministic — `tasks_source_type_check` is what
--   Postgres itself generates for the inline column check in the original
--   CREATE TABLE, so this statement collides with that name on purpose rather
--   than leaving two constraints behind.
--
--   Non-breaking. The new predicate only ADDS a permitted value, so every row
--   already in `tasks` satisfies it and the validation scan that ADD CONSTRAINT
--   runs cannot fail — including on the rows written between the DROP and the
--   ADD, which this transaction holds an ACCESS EXCLUSIVE lock against anyway.
--   Removing a value from this list is the dangerous direction and would need a
--   data migration before the constraint could be narrowed.
--
-- Kept in step with ensureRuntimeSchema() in server/index.cjs and with
-- database/neon-schema.sql. All three must list the same values.
-- ---------------------------------------------------------------------------

ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_source_type_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_source_type_check
  CHECK (source_type IN ('manual', 'chat', 'document', 'canvas', 'ai', 'feedback', 'automation'));
