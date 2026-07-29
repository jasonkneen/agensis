'use strict';

// ============================================================================
// server/workspace-skills-routes.cjs — the app-side skill store's write door.
// ----------------------------------------------------------------------------
// Dependencies are INJECTED rather than imported, matching every other
// *-routes.cjs here, so the auth, RBAC and realtime contract stays
// single-sourced in index.cjs / backend-core.cjs.
//
// WHY THESE ROUTES EXIST. shared/workspaceSkills.cjs is the security surface;
// the generic /backend/db path cannot run it. So DB_TABLE_ACCESS gates generic
// writes on `workspace_skills` to 'manage' and authoring comes through here,
// where a never-carried field is REFUSED with a message naming it rather than
// silently dropped — and where the name rule and the 64 KiB body cap are
// applied. A name that fails the agentskills.io rule is a skill `read_skill`
// can never look up; a silent drop is how somebody comes to believe they
// authored a skill that calls an API.
//
// ROLES. Read is 'read'; authoring, editing and deleting are 'write'. That
// matches workspace_agent_templates and it is argued in full at the top of
// shared/workspaceSkills.cjs: a 'write' member can already type prose into an
// agent's system_prompt, which the agent obeys as TRUSTED text every turn,
// whereas a skill body reaches an agent FENCED as untrusted reference data.
//
// WHAT THESE ROUTES DELIBERATELY DO NOT DO:
//
//   - Write a file onto anyone's machine. Skills flow UP from daemons into
//     agent_skill_documents and that is unchanged. Agents read these bodies at
//     turn time through `read_skill`. There is no push-down, and adding one
//     would be a strictly larger authority than any daemon holds today.
//   - Touch `workspace_agents.skills`. Authoring a skill does not attach it to
//     an agent — that is a separate, deliberate act on the agent row, through
//     the guards that already exist there.
//   - Accept `source` or `origin` from the caller. Both are provenance, set
//     here, and stripped from the generic path by PRIVILEGED_DB_COLUMNS_BY_TABLE.

const {
 MAX_SKILLS_PER_WORKSPACE,
 SKILL_SOURCES,
 normalizeWorkspaceSkill,
} = require('../shared/workspaceSkills.cjs');

function badRequest(message) {
 return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
 return Object.assign(new Error(message), { status: 404 });
}

function conflict(message) {
 return Object.assign(new Error(message), { status: 409 });
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

/**
 * The row as a client sees it. An explicit projection rather than `*`, so a
 * column added later does not silently start reaching browsers — the same rule
 * SELECTABLE_COLUMNS_BY_TABLE enforces on the generic path.
 */
function publicSkill(row) {
 if (!row) return null;
 return {
  id: row.id,
  workspace_id: row.workspace_id,
  name: row.name,
  title: row.title,
  summary: row.summary || '',
  body: row.body || '',
  revision: Number(row.revision || 1),
  source: row.source || 'authored',
  origin: parseObject(row.origin),
  created_by: row.created_by || null,
  created_at: row.created_at,
  updated_at: row.updated_at,
 };
}

function createWorkspaceSkills(deps = {}) {
 const { getDb, notifyDbSubscribers, enforceWorkspaceRole } = deps;

 async function listWorkspaceSkillRows(workspaceId) {
  return getDb().unsafe(
   'select * from workspace_skills where workspace_id = $1 order by name asc limit $2',
   [String(workspaceId), MAX_SKILLS_PER_WORKSPACE],
  );
 }

 async function listSkills({ userId, workspaceId } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'read');
  return (await listWorkspaceSkillRows(id)).map(publicSkill);
 }

 /**
  * Insert or update by (workspace_id, name).
  *
  * `source` and `origin` are arguments of THIS function and never fields of the
  * caller's payload — normalizeWorkspaceSkill refuses a payload that so much as
  * mentions them. A caller that could claim source='authored' on a body accepted
  * from a thread harvest would erase the only record of where the procedure came
  * from, which is the question somebody asks after an agent follows it.
  */
 async function writeSkill({ workspaceId, skill, userId, source, origin = {} }) {
  const provenance = SKILL_SOURCES.has(String(source)) ? String(source) : 'authored';
  const rows = await getDb().unsafe(
   `insert into workspace_skills
      (workspace_id, name, title, summary, body, source, origin, created_by)
    values ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    on conflict (workspace_id, name) do update set
       title = excluded.title,
       summary = excluded.summary,
       body = excluded.body,
       revision = workspace_skills.revision + 1,
       updated_at = now()
    returning *`,
   [
    String(workspaceId), skill.name, skill.title, skill.summary, skill.body,
    provenance,
    // Bound as an OBJECT, never stringified: porsager turns a stringified
    // ::jsonb bind into a jsonb string scalar (tests/jsonb-bind-hygiene.test.cjs).
    origin,
    userId ? String(userId) : null,
   ],
  );
  return rows[0] || null;
 }

 /**
  * Author a new skill.
  *
  * REFUSES rather than upserts when the name is taken. The upsert in writeSkill
  * exists for the accept-a-suggestion path, where re-accepting the same proposal
  * should converge; here, "create" silently overwriting somebody else's
  * procedure because two titles slugified the same way is a way to lose work
  * without anyone seeing it happen.
  */
 async function createSkill({ userId, workspaceId, skill } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'write');

  const result = normalizeWorkspaceSkill(skill);
  if (!result.ok) throw badRequest(result.errors.join('; '));

  const existing = await getDb().unsafe(
   'select id from workspace_skills where workspace_id = $1 and name = $2 limit 1',
   [id, result.skill.name],
  );
  if (existing[0]) {
   throw conflict(`A skill named "${result.skill.name}" already exists here. Edit it, or choose another name.`);
  }

  const count = await getDb().unsafe(
   'select count(*)::int as total from workspace_skills where workspace_id = $1',
   [id],
  );
  if (Number(count[0]?.total || 0) >= MAX_SKILLS_PER_WORKSPACE) {
   throw badRequest(`This workspace already has the maximum of ${MAX_SKILLS_PER_WORKSPACE} skills.`);
  }

  const row = await writeSkill({ workspaceId: id, skill: result.skill, userId, source: 'authored', origin: {} });
  if (row) notifyDbSubscribers('workspace_skills', 'INSERT', [row]);
  return publicSkill(row);
 }

 /**
  * Edit an existing skill.
  *
  * The NAME IS NOT EDITABLE, and that is deliberate rather than an omission. The
  * name is a lookup key: it is what `read_skill` resolves, what a template's
  * `skills` array holds, and what an agent row's `skills` list names. Renaming
  * would silently break every one of those references at once, with no signal
  * anywhere. Deleting and re-creating makes the breakage visible, which is the
  * honest version of the same operation.
  */
 async function updateSkill({ userId, workspaceId, skillId, skill } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(skillId || '').trim();
  if (!id || !target) throw badRequest('workspace id and skill id are required');
  await enforceWorkspaceRole(userId, id, 'write');

  const existing = await getDb().unsafe(
   'select * from workspace_skills where id = $1 and workspace_id = $2 limit 1',
   [target, id],
  );
  if (!existing[0]) throw notFound('That skill was not found');

  const result = normalizeWorkspaceSkill({ ...skill, name: existing[0].name });
  if (!result.ok) throw badRequest(result.errors.join('; '));

  const rows = await getDb().unsafe(
   `update workspace_skills
       set title = $3, summary = $4, body = $5, revision = revision + 1, updated_at = now()
     where id = $1 and workspace_id = $2
     returning *`,
   [target, id, result.skill.title, result.skill.summary, result.skill.body],
  );
  if (!rows.length) throw notFound('That skill was not found');
  notifyDbSubscribers('workspace_skills', 'UPDATE', rows);
  return publicSkill(rows[0]);
 }

 async function deleteSkill({ userId, workspaceId, skillId } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(skillId || '').trim();
  if (!id || !target) throw badRequest('workspace id and skill id are required');
  await enforceWorkspaceRole(userId, id, 'write');
  const rows = await getDb().unsafe(
   'delete from workspace_skills where id = $1 and workspace_id = $2 returning *',
   [target, id],
  );
  if (!rows.length) throw notFound('That skill was not found');
  notifyDbSubscribers('workspace_skills', 'DELETE', rows);
  return { id: target, deleted: true };
 }

 return { listSkills, createSkill, updateSkill, deleteSkill, writeSkill, publicSkill };
}

function mountWorkspaceSkillRoutes(app, deps = {}) {
 const { requireAuth, jsonError, listSkills, createSkill, updateSkill, deleteSkill } = deps;

 app.get('/backend/workspaces/:id/skills', requireAuth, async (req, res) => {
  try {
   const data = await listSkills({ userId: req.userId, workspaceId: req.params.id });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/skills', requireAuth, async (req, res) => {
  try {
   const data = await createSkill({
    userId: req.userId, workspaceId: req.params.id, skill: req.body?.skill ?? req.body,
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.patch('/backend/workspaces/:id/skills/:skillId', requireAuth, async (req, res) => {
  try {
   const data = await updateSkill({
    userId: req.userId,
    workspaceId: req.params.id,
    skillId: req.params.skillId,
    skill: req.body?.skill ?? req.body,
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.delete('/backend/workspaces/:id/skills/:skillId', requireAuth, async (req, res) => {
  try {
   const data = await deleteSkill({
    userId: req.userId, workspaceId: req.params.id, skillId: req.params.skillId,
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { createWorkspaceSkills, mountWorkspaceSkillRoutes, publicSkill };
