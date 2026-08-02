-- Keep tenant identity intact when nullable controller attribution is removed.
-- An unqualified SET NULL on a composite FK nulls workspace_id too, but every
-- referencing table requires workspace_id. PostgreSQL therefore rejected a
-- controller delete instead of clearing only the attribution column.

ALTER TABLE workspace_controllers
  DROP CONSTRAINT IF EXISTS workspace_controllers_parent_workspace_fkey;
ALTER TABLE workspace_controllers
  ADD CONSTRAINT workspace_controllers_parent_workspace_fkey
  FOREIGN KEY (parent_controller_id, workspace_id)
  REFERENCES workspace_controllers(id, workspace_id)
  ON DELETE SET NULL (parent_controller_id);

ALTER TABLE workspace_agents
  DROP CONSTRAINT IF EXISTS workspace_agents_controller_workspace_fkey;
ALTER TABLE workspace_agents
  ADD CONSTRAINT workspace_agents_controller_workspace_fkey
  FOREIGN KEY (controller_id, workspace_id)
  REFERENCES workspace_controllers(id, workspace_id)
  ON DELETE SET NULL (controller_id);

ALTER TABLE workspace_resources
  DROP CONSTRAINT IF EXISTS workspace_resources_controller_workspace_fkey;
ALTER TABLE workspace_resources
  ADD CONSTRAINT workspace_resources_controller_workspace_fkey
  FOREIGN KEY (controller_id, workspace_id)
  REFERENCES workspace_controllers(id, workspace_id)
  ON DELETE SET NULL (controller_id);

ALTER TABLE agent_registrations
  DROP CONSTRAINT IF EXISTS agent_registrations_controller_workspace_fkey;
ALTER TABLE agent_registrations
  ADD CONSTRAINT agent_registrations_controller_workspace_fkey
  FOREIGN KEY (controller_id, workspace_id)
  REFERENCES workspace_controllers(id, workspace_id)
  ON DELETE SET NULL (controller_id);

ALTER TABLE workspace_join_links
  DROP CONSTRAINT IF EXISTS workspace_join_links_redeemed_controller_workspace_fkey;
ALTER TABLE workspace_join_links
  ADD CONSTRAINT workspace_join_links_redeemed_controller_workspace_fkey
  FOREIGN KEY (redeemed_controller_id, workspace_id)
  REFERENCES workspace_controllers(id, workspace_id)
  ON DELETE SET NULL (redeemed_controller_id);
