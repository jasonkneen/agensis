'use strict';

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// /backend/system/* — what this HOST can do: which agent CLIs and SDKs are
// installed, which slash commands connected daemons advertise, and the skill and
// agent libraries on disk.
//
// Everything here reports on the machine the backend runs on, not on a
// workspace, so the reads are gated on AGENSIS_ALLOW_PROJECT_FS via
// projectFsAllowed and confined to skills/agents/commands. `config` is excluded
// on purpose — ~/.gemini/settings.json holds API keys.

function mountSystemRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole, getDb, rateLimitBlocked,
  clientIpFromReq, parseJsonObject, detectCapabilities, inspectProjectPath,
  mergeSlashCommands, skillContentPayload, skillLibraryPayload,
  skillRateLimiter,
 } = deps;

 app.get('/backend/system/capabilities', requireAuth, async (req, res) => {
  try {
   const workspacePath = typeof req.query.workspacePath === 'string' ? req.query.workspacePath : '';
   res.json({ data: await detectCapabilities(workspacePath), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Slash commands/skills the connected daemons actually expose on their machines.
 // The composer's `/` menu can't see the user's filesystem (only fly's), so it
 // sources the real commands from what each daemon pushed on its capability sync.
 app.get('/backend/system/slash-commands', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.query.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    `select capabilities
         from agent_connections
         where workspace_id = $1
           and last_seen_at > now() - interval '24 hours'`,
    [workspaceId],
   );
   const items = mergeSlashCommands(rows.map(row => parseJsonObject(row.capabilities)));
   res.json({ data: items, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // The BODY behind a row in the Skills window. Three shapes, one route:
 //   ?skill=<name>            -> the document for a skill some agent carries
 //   ?library=<id>            -> the entries inside a detected skill library
 //   ?library=<id>&entry=<n>  -> one entry's markdown
 //
 // Fly only (like /backend/system/slash-commands): the hosted frontend targets the
 // Fly backend for every /backend call, and the sandbox-skill resolution needs the
 // CommonJS skill modules. Not on Netlify.
 //
 // Workspace-scoped throughout — the skills, the authored definitions and the
 // daemon-pushed documents are all read WHERE workspace_id = the id the caller
 // proved `read` on, so a member of one workspace cannot reach another's.
 app.get('/backend/system/skill-content', requireAuth, async (req, res) => {
  try {
   if (rateLimitBlocked(res, skillRateLimiter, `skill-content:${req.userId || clientIpFromReq(req)}`)) return;
   const workspaceId = String(req.query.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspaceId is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');

   const libraryId = String(req.query.library || '').trim();
   if (libraryId) return res.json({ data: await skillLibraryPayload(libraryId, String(req.query.entry || '')), error: null });

   const skill = String(req.query.skill || '').trim().slice(0, 200);
   if (!skill) return jsonError(res, 400, new Error('skill or library is required'));
   res.json({ data: await skillContentPayload(workspaceId, skill), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/system/inspect-path', requireAuth, async (req, res) => {
  try {
   const inspected = await inspectProjectPath(req.body?.path || '');
   res.json({ data: inspected, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = { mountSystemRoutes };
