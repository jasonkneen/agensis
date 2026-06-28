-- Store the selected OpenPets catalog id for agent avatars.
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS openpet_avatar_id text DEFAULT '';
