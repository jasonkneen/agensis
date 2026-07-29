'use strict';

// ============================================================================
// server/agent-templates-routes.cjs
// ----------------------------------------------------------------------------
// Agent templates ("persona packs"). Dependencies are INJECTED rather than
// imported, matching every other *-routes.cjs here, so the auth, RBAC and
// rate-limit contract stays single-sourced in index.cjs / backend-core.cjs.
//
// WHAT THESE ROUTES ARE FOR. The validator (shared/agentTemplates.cjs) is the
// security surface; these routes exist because the generic /backend/db path
// cannot run it. Authoring goes through here so a never-carried field is
// REFUSED with a message naming it, rather than silently dropped — a silent drop
// is how someone comes to believe they saved a permission mode and that the
// agent they hand over will run in it.
//
// WHAT THESE ROUTES DELIBERATELY DO NOT DO: create an agent. There is no
// server-side create-agent path here and there must not be one. A template
// prefills the existing Agents window form, and the write still goes through the
// generic /backend/db/insert where stripPrivilegedDbValues and
// setsManageOnlyDbColumn apply unchanged. Adding a convenience
// "create-from-template" route that inserts server-side would step around every
// column guard in shared/backend-core.cjs at once.
//
// ROLES. Read is 'read'; authoring, editing and deleting are 'write'. That is
// deliberate and matches workspace_agents itself: a 'write' member can already
// type a system prompt straight into an agent, so writing the same prose into a
// template grants nothing new. Crossing a WORKSPACE BOUNDARY would be different
// — an imported prompt is attacker-influenced text that a teammate's agent will
// later speak — and that is why import is 'manage' when it is built. It is not
// built in v1; see the report.

const MAX_TEMPLATES_PER_WORKSPACE = 200;

function badRequest(message) {
 return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
 return Object.assign(new Error(message), { status: 404 });
}

/**
 * The row as a client sees it. An explicit projection rather than `*` so a
 * column added later does not silently start reaching browsers.
 */
function publicTemplate(row) {
 if (!row) return null;
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  slug: row.slug,
  name: row.name,
  category: row.category || 'Custom',
  description: row.description || '',
  handleHint: row.handle_hint || '',
  systemPrompt: row.system_prompt || '',
  soul: row.soul || '',
  instructions: row.instructions || '',
  tools: parseList(row.tools),
  skills: parseList(row.skills),
  model: row.model || 'auto',
  runMode: row.run_mode || 'builtin',
  runtime: row.runtime || '',
  avatar: row.avatar || '',
  accentColor: row.accent_color || '',
  revision: Number(row.revision || 1),
  source: row.source || 'authored',
  origin: parseObject(row.origin),
  created_by: row.created_by || null,
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
}

function parseList(value) {
 if (Array.isArray(value)) return value;
 if (typeof value !== 'string') return [];
 try {
  const parsed = JSON.parse(value);
  return Array.isArray(parsed) ? parsed : [];
 } catch {
  return [];
 }
}

function parseObject(value) {
 if (value && typeof value === 'object' && !Array.isArray(value)) return value;
 if (typeof value !== 'string') return {};
 try {
  const parsed = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
 } catch {
  return {};
 }
}

function createAgentTemplates(deps = {}) {
 const {
  getDb,
  notifyDbSubscribers,
  enforceWorkspaceRole,
  normalizeAgentTemplate,
  agentToTemplateDraft,
 } = deps;

 async function listAgentTemplates({ userId, workspaceId } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'read');
  const rows = await getDb().unsafe(
   'select * from workspace_agent_templates where workspace_id = $1 order by created_at desc limit $2',
   [id, MAX_TEMPLATES_PER_WORKSPACE],
  );
  return rows.map(publicTemplate);
 }

 /**
  * Insert or update, by (workspace_id, slug).
  *
  * `source` is set HERE and is never taken from the caller — it is provenance,
  * and a caller that could claim source='authored' on an imported body would
  * erase the only record of where the prose came from.
  */
 async function writeTemplate({ workspaceId, template, userId, source, origin = {} }) {
  const rows = await getDb().unsafe(
   `insert into workspace_agent_templates
      (workspace_id, slug, name, category, description, handle_hint,
       system_prompt, soul, instructions, tools, skills, model, run_mode,
       runtime, avatar, accent_color, source, origin, created_by)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15,$16,$17,$18::jsonb,$19)
    on conflict (workspace_id, slug) do update set
       name = excluded.name,
       category = excluded.category,
       description = excluded.description,
       handle_hint = excluded.handle_hint,
       system_prompt = excluded.system_prompt,
       soul = excluded.soul,
       instructions = excluded.instructions,
       tools = excluded.tools,
       skills = excluded.skills,
       model = excluded.model,
       run_mode = excluded.run_mode,
       runtime = excluded.runtime,
       avatar = excluded.avatar,
       accent_color = excluded.accent_color,
       revision = workspace_agent_templates.revision + 1,
       updated_at = now()
    returning *`,
   [
    workspaceId, template.slug, template.name, template.category, template.description,
    template.handleHint, template.systemPrompt, template.soul, template.instructions,
    // Bound as OBJECTS, never stringified: porsager turns a stringified ::jsonb
    // bind into a jsonb string scalar (tests/jsonb-bind-hygiene.test.cjs).
    template.tools, template.skills,
    template.model, template.runMode, template.runtime, template.avatar, template.accentColor,
    source, origin, String(userId || ''),
   ],
  );
  return rows[0] || null;
 }

 async function createAgentTemplate({ userId, workspaceId, template } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'write');

  const result = normalizeAgentTemplate(template);
  if (!result.ok) throw badRequest(result.errors.join('; '));

  const row = await writeTemplate({
   workspaceId: id, template: result.template, userId, source: 'authored', origin: {},
  });
  if (row) notifyDbSubscribers('workspace_agent_templates', 'INSERT', [row]);
  return publicTemplate(row);
 }

 /**
  * "Save this agent as a template."
  *
  * THE PRIVILEGE-STRIP HAPPENS HERE, and this is the path most likely to grow a
  * hole: the row read below is a full workspace_agents record, so it carries
  * permission_mode, metadata (host_folders, sandbox_skills), sandbox_config and
  * connect_token_hash. agentToTemplateDraft PICKS named fields and never spreads
  * the row — spreading it would copy a yolo agent's permission mode and its
  * `--add-dir /` into a shareable artifact in one line.
  */
 async function saveAgentAsTemplate({ userId, workspaceId, agentId } = {}) {
  const id = String(workspaceId || '').trim();
  const agent = String(agentId || '').trim();
  if (!id || !agent) throw badRequest('workspace id and agent id are required');
  await enforceWorkspaceRole(userId, id, 'write');

  const rows = await getDb().unsafe(
   'select * from workspace_agents where id = $1 and workspace_id = $2 limit 1',
   [agent, id],
  );
  if (!rows[0]) throw notFound('Agent was not found');

  const draft = agentToTemplateDraft(rows[0]);
  const result = normalizeAgentTemplate(draft);
  // A draft this module built itself must always validate. If it does not, the
  // picker and the validator have drifted, and guessing is worse than failing.
  if (!result.ok) throw badRequest(`Could not save this agent as a template: ${result.errors.join('; ')}`);

  const row = await writeTemplate({
   workspaceId: id,
   template: result.template,
   userId,
   source: 'derived',
   origin: { derivedFromAgentId: agent, derivedAt: new Date().toISOString() },
  });
  if (row) notifyDbSubscribers('workspace_agent_templates', 'INSERT', [row]);
  return publicTemplate(row);
 }

 async function updateAgentTemplate({ userId, workspaceId, templateId, template } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(templateId || '').trim();
  if (!id || !target) throw badRequest('workspace id and template id are required');
  await enforceWorkspaceRole(userId, id, 'write');

  const existing = await getDb().unsafe(
   'select * from workspace_agent_templates where id = $1 and workspace_id = $2 limit 1',
   [target, id],
  );
  if (!existing[0]) throw notFound('Template was not found');

  const result = normalizeAgentTemplate({ ...template, slug: existing[0].slug });
  if (!result.ok) throw badRequest(result.errors.join('; '));

  const rows = await getDb().unsafe(
   `update workspace_agent_templates
       set name = $3, category = $4, description = $5, handle_hint = $6,
           system_prompt = $7, soul = $8, instructions = $9,
           tools = $10::jsonb, skills = $11::jsonb, model = $12, run_mode = $13,
           runtime = $14, avatar = $15, accent_color = $16,
           revision = revision + 1, updated_at = now()
     where id = $1 and workspace_id = $2
     returning *`,
   [
    target, id, result.template.name, result.template.category, result.template.description,
    result.template.handleHint, result.template.systemPrompt, result.template.soul,
    result.template.instructions, result.template.tools, result.template.skills,
    result.template.model, result.template.runMode, result.template.runtime,
    result.template.avatar, result.template.accentColor,
   ],
  );
  if (!rows.length) throw notFound('Template was not found');
  notifyDbSubscribers('workspace_agent_templates', 'UPDATE', rows);
  return publicTemplate(rows[0]);
 }

 async function deleteAgentTemplate({ userId, workspaceId, templateId } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(templateId || '').trim();
  if (!id || !target) throw badRequest('workspace id and template id are required');
  await enforceWorkspaceRole(userId, id, 'write');
  const rows = await getDb().unsafe(
   'delete from workspace_agent_templates where id = $1 and workspace_id = $2 returning *',
   [target, id],
  );
  if (!rows.length) throw notFound('Template was not found');
  notifyDbSubscribers('workspace_agent_templates', 'DELETE', rows);
  return { id: target, deleted: true };
 }

 return {
  listAgentTemplates,
  createAgentTemplate,
  saveAgentAsTemplate,
  updateAgentTemplate,
  deleteAgentTemplate,
  publicTemplate,
 };
}

function mountAgentTemplateRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError,
  listAgentTemplates, createAgentTemplate, saveAgentAsTemplate,
  updateAgentTemplate, deleteAgentTemplate,
 } = deps;

 app.get('/backend/workspaces/:id/agent-templates', requireAuth, async (req, res) => {
  try {
   const data = await listAgentTemplates({ userId: req.userId, workspaceId: req.params.id });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/agent-templates', requireAuth, async (req, res) => {
  try {
   const data = await createAgentTemplate({
    userId: req.userId, workspaceId: req.params.id, template: req.body?.template ?? req.body,
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/agent-templates/from-agent/:agentId', requireAuth, async (req, res) => {
  try {
   const data = await saveAgentAsTemplate({
    userId: req.userId, workspaceId: req.params.id, agentId: req.params.agentId,
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/workspaces/:id/agent-templates/:templateId', requireAuth, async (req, res) => {
  try {
   const data = await updateAgentTemplate({
    userId: req.userId,
    workspaceId: req.params.id,
    templateId: req.params.templateId,
    template: req.body?.template ?? req.body,
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/agent-templates/:templateId', requireAuth, async (req, res) => {
  try {
   const data = await deleteAgentTemplate({
    userId: req.userId, workspaceId: req.params.id, templateId: req.params.templateId,
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { createAgentTemplates, mountAgentTemplateRoutes, publicTemplate, MAX_TEMPLATES_PER_WORKSPACE };
