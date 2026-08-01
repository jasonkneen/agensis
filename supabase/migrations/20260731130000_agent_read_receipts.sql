-- Agent read receipts.
--
-- The original session_read_state (20260731120000) modelled a reader as a human
-- only: user_id NOT NULL REFERENCES app_users, PK (session_id, user_id). An agent
-- is not in app_users, so it could never register "I have seen this" — which is
-- the whole point of a receipt in an agent workspace.
--
-- This generalises the reader to EITHER a human (user_id -> app_users) or an
-- agent (agent_id -> workspace_agents): both nullable, a CHECK that exactly one
-- is set, and a partial unique index per kind replacing the (session_id, user_id)
-- primary key (a PK column cannot be null, and each column is null for the other
-- kind). The DDL is single-sourced in shared/read-receipts.cjs (SESSION_READ_STATE_DDL,
-- run by ensureRuntimeSchema on a Fly boot); this file restates it so a database
-- built from migrations alone matches one built from a boot.
--
-- All idempotent: a fresh DB gets the new shape from the CREATE above it, an
-- existing one is upgraded in place here.

-- Order matters: drop the PK before widening user_id — Postgres refuses to
-- remove NOT NULL from a column that is still part of a primary key.
ALTER TABLE session_read_state ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES workspace_agents(id) ON DELETE CASCADE;
ALTER TABLE session_read_state DROP CONSTRAINT IF EXISTS session_read_state_pkey;
ALTER TABLE session_read_state ALTER COLUMN user_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'session_read_state_one_reader') THEN
    ALTER TABLE session_read_state ADD CONSTRAINT session_read_state_one_reader
      CHECK ((user_id IS NOT NULL) <> (agent_id IS NOT NULL));
  END IF;
END $$;

-- A database that has already booted a newer runtime may already carry the
-- thread-scoped shape from 20260731181000 (or database/neon-schema.sql). In
-- that shape, two rows for the same session/agent are valid when they belong to
-- different thread roots, so the transitional session-wide index would reject
-- real data before the scoped migration gets a chance to replace it. Fresh
-- migration-only databases do not have thread_parent_id yet and still receive
-- the temporary indexes below; 20260731181000 drops them after adding scope.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'session_read_state'
       AND column_name = 'thread_parent_id'
  ) THEN
    CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_user_uidx
      ON session_read_state (session_id, user_id) WHERE user_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS session_read_state_agent_uidx
      ON session_read_state (session_id, agent_id) WHERE agent_id IS NOT NULL;
  END IF;
END $$;
