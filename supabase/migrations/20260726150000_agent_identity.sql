-- Agent self-declared identity: avatar, name, profile and how the agent sounds.
--
-- workspace_agents.identity holds
--   { voice: { locale, variant, rate, pitch }, human_set: { <field>: true } }
--
-- `voice` is a PREFERENCE, not a device value. speechSynthesis.getVoices()
-- returns a different list per OS, browser and install, so storing a voice name
-- would make an agent sound right on one machine and fall back to the default on
-- every other, silently. An accent (BCP-47), a variant index within that accent,
-- and rate/pitch are meaningful everywhere; the browser resolves them against
-- whatever it actually has at speak time.
--
-- `human_set` records which identity fields a person explicitly chose. An agent
-- re-declares its identity on every connect, so without this a name or avatar
-- someone picked in the UI would be destroyed on the next daemon restart. The
-- rule (shared/agentIdentity.cjs): a human's explicit choice beats the agent's
-- self-declaration; the agent's values are a default for fields nobody has set.
--
-- Not a key in workspace_agents.metadata: metadata is manage-only in the generic
-- db write gate (it carries host_folders, which widens an agent's filesystem
-- access), and picking an accent is not a privilege escalation.
ALTER TABLE workspace_agents ADD COLUMN IF NOT EXISTS identity jsonb NOT NULL DEFAULT '{}'::jsonb;

-- MCP approval is asynchronous (register_agent -> pending -> owner popup ->
-- approved), and for a brand new agent the row does not exist until approval.
-- Park the declaration here so it survives the round trip.
ALTER TABLE agent_registrations ADD COLUMN IF NOT EXISTS requested_identity jsonb NOT NULL DEFAULT '{}'::jsonb;
