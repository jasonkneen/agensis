-- Groupable workspaces — foundation only (no nesting UI yet).
--
-- Workspaces become groupable through a nullable self-reference rather than a
-- new table or a new tier: a workspace WITH children renders as a group, one
-- without renders as a leaf. A parent may hold its own content as well as
-- children.
--
-- Inheritance rule this column encodes: a child inherits AGENTS and MEMBERS
-- from its ancestors; CONTENT (channels, documents, tasks, memory) belongs to
-- exactly one workspace and is never visible from a sibling or a parent.
-- Access flows strictly DOWNWARD.
--
-- ON DELETE RESTRICT, deliberately:
--   CASCADE  would silently destroy every client workspace beneath a deleted
--            agency parent, along with all of their content.
--   SET NULL would silently promote the children to top level AND, because
--            members inherit downward, strip everyone whose access came only
--            from the parent — potentially leaving a workspace with no members.
--   RESTRICT fails the delete while children exist, forcing an explicit
--            re-parent or delete first. It is the only option that cannot lose
--            or leak a client's data behind the operator's back.

ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS parent_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_parent_id_fkey'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_parent_id_fkey
      FOREIGN KEY (parent_id) REFERENCES workspaces(id) ON DELETE RESTRICT;
  END IF;

  -- The 1-cycle (a workspace as its own parent), declaratively.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'workspaces_parent_id_not_self'
  ) THEN
    ALTER TABLE workspaces
      ADD CONSTRAINT workspaces_parent_id_not_self
      CHECK (parent_id IS NULL OR parent_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_workspaces_parent_id ON workspaces(parent_id);

-- Every LONGER cycle (A -> B -> A, and deeper chains) needs a walk, so it is a
-- trigger rather than a CHECK. Enforced at the database, not only at the API
-- gate, because a cycle makes the recursive ancestor walk in the AUTHORIZATION
-- path spin until statement_timeout on every request touching that workspace —
-- a single bad row would be a denial of service, reachable from any writer
-- (daemon, MCP server, migration, psql).
CREATE OR REPLACE FUNCTION workspaces_reject_parent_cycle()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id uuid := NEW.parent_id;
  steps int := 0;
BEGIN
  WHILE cursor_id IS NOT NULL LOOP
    IF cursor_id = NEW.id THEN
      RAISE EXCEPTION 'workspace % cannot be its own ancestor', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    steps := steps + 1;
    -- Mirrors WORKSPACE_MAX_DEPTH in shared/workspace-tree.cjs. Bounds every
    -- recursive walk; also terminates on a cycle the CHECK cannot see.
    IF steps > 10 THEN
      RAISE EXCEPTION 'workspace nesting exceeds the maximum depth of 10'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT parent_id INTO cursor_id FROM workspaces WHERE id = cursor_id;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_workspaces_reject_parent_cycle ON workspaces;
CREATE TRIGGER trg_workspaces_reject_parent_cycle
  BEFORE INSERT OR UPDATE OF parent_id ON workspaces
  FOR EACH ROW
  WHEN (NEW.parent_id IS NOT NULL)
  EXECUTE FUNCTION workspaces_reject_parent_cycle();
