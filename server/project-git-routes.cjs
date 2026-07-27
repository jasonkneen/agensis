'use strict';

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// Routes extracted verbatim from server/index.cjs (Wave 2 of the index.cjs
// reduction). Mounted once by index.cjs; every dependency is INJECTED rather
// than imported, so the auth, RBAC and rate-limit contract stays single-sourced
// in index.cjs / shared/backend-core.cjs and this file cannot drift from it.
//
// Project files and git, read and written on the BACKEND HOST.
//
// Every route here is gated twice: AGENSIS_ALLOW_PROJECT_FS must be on, and the
// resolved path must sit inside AGENSIS_PROJECT_ROOTS. Both checks live in
// server/lib/project-fs.cjs and are injected, never re-derived — git_root and
// local_path are workspace columns any 'manage' user can write through the
// generic /backend/db/* update, and they feed straight into fs reads and
// `git -C <root>` on this machine.
//
// The shared fly.dev backend leaves both env vars unset, so these routes return
// their empty payload rather than touching disk. A per-user local daemon opts in.

function mountProjectGitRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, badRequest, enforceWorkspaceRole, getDb,
  isWithinAllowedProjectRoot, listProjectFiles, workspaceProjectFileSources,
 } = deps;
 // fetchWorkspaceRow, gitRootOf, resolveWithinRoot, parsePorcelainStatus,
 // requireWritableGitRoot and resolveStagePaths are declared BELOW, inside this
 // function — they were nested helpers of createApp() serving only these routes,
 // so they travel with them rather than being injected.

 app.get('/backend/workspaces/:id/project-files', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await getDb().unsafe(
    'select id, local_path, git_root from workspaces where id = $1 limit 1',
    [workspaceId],
   );
   const workspace = rows[0];
   if (!workspace) return jsonError(res, 404, new Error('Workspace not found'));
   const requestedAgents = Array.isArray(req.query.agent)
    ? req.query.agent
    : req.query.agent
     ? [req.query.agent]
     : [];
   const sources = await workspaceProjectFileSources(workspaceId, workspace, { agents: requestedAgents });
   if (sources.length === 0) return res.json({ data: { root: '', files: [], sources: [] }, error: null });
   const fileSources = sources.map(source => {
    const files = listProjectFiles(source.root, source.kind === 'agent' ? 160 : 300).map(file => ({
     ...file,
     sourceId: source.id,
     sourceKind: source.kind,
     sourceLabel: source.label,
     sourceRoot: source.root,
     agentId: source.agent_id || null,
     connectionId: source.connection_id || null,
     handle: source.handle || '',
     status: source.status || '',
    }));
    return { ...source, files };
   });
   res.json({
    data: {
     root: fileSources.find(source => source.kind === 'workspace')?.root || '',
     files: fileSources.flatMap(source => source.files),
     sources: fileSources,
    },
    error: null,
   });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Resolve a workspace's git root and validate that `relativePath` (a path the
 // client supplied) stays inside it — without this, a diff/status endpoint that
 // takes an arbitrary path query param would let any authenticated workspace
 // member read files anywhere on the host's filesystem via `../../` traversal.
 async function fetchWorkspaceRow(workspaceId) {
  const rows = await getDb().unsafe(
   'select id, local_path, git_root from workspaces where id = $1 limit 1',
   [workspaceId],
  );
  return rows[0] || null;
 }

 function gitRootOf(workspace) {
  if (!workspace) return null;
  const root = String(workspace.git_root || workspace.local_path || '').trim();
  if (!root) return null;
  const resolved = path.resolve(root);
  // F3: never touch a root outside the host's opt-in allowlist (see
  // isWithinAllowedProjectRoot above workspaceProjectRoot).
  if (!isWithinAllowedProjectRoot(resolved)) return null;
  return resolved;
 }

 function resolveWithinRoot(root, relativePath) {
  const resolved = path.resolve(root, String(relativePath || ''));
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) return null;
  // Lexical containment isn't enough — a symlink inside root can point outside it.
  // Only realpath-check if the target exists; callers that need "path must exist"
  // semantics (e.g. resolveStagePaths, which stages an existing file) already get
  // that for free, and callers reading a possibly-new path should catch the ENOENT
  // case themselves the way the diff route's untracked-file branch already does.
  let realTarget;
  try {
   realTarget = fs.realpathSync(resolved);
  } catch {
   return resolved; // Path doesn't exist yet — lexical check already passed; let the
   // caller's own existence check (if any) handle the not-found case.
  }
  const realRoot = fs.realpathSync(root);
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) return null;
  return resolved;
 }

 // Lightweight parser for `git status --porcelain=v1 -z`: two status chars per
 // entry (index, worktree) followed by the path, NUL-separated (handles paths
 // with spaces/newlines safely, unlike the newline-delimited non -z format).
 function parsePorcelainStatus(raw) {
  return raw
   .split('\0')
   .filter(Boolean)
   .map((entry) => {
    const indexState = entry[0];
    const worktreeState = entry[1];
    const filePath = entry.slice(3);
    let status = 'modified';
    if (indexState === '?' && worktreeState === '?') status = 'untracked';
    else if (indexState === 'A') status = 'added';
    else if (indexState === 'D' || worktreeState === 'D') status = 'deleted';
    else if (indexState === 'R') status = 'renamed';
    return { path: filePath, status, staged: indexState !== ' ' && indexState !== '?' };
   });
 }

 app.get('/backend/workspaces/:id/git/status', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const workspaceRow = await fetchWorkspaceRow(workspaceId);
   const root = gitRootOf(workspaceRow);
   if (!root || !fs.existsSync(root)) return res.json({ data: { root: '', files: [], branch: '' }, error: null });
   let branch = '';
   try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'branch', '--show-current'], { timeout: 5000 });
    branch = stdout.trim();
   } catch {
    return res.json({ data: { root, files: [], branch: '' }, error: null });
   }
   const { stdout } = await execFileAsync(
    'git', ['-C', root, 'status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
   );
   const files = parsePorcelainStatus(stdout);

   // Attribute each changed file to the agent connection whose cwd contains it
   // (best-effort — same source data the Files panel already uses), so the UI
   // can show "changed by Atlas" rather than just a bare path.
   let sources = [];
   try {
    sources = await workspaceProjectFileSources(workspaceId, workspaceRow, {});
   } catch {
    // attribution is best-effort; status itself still returns
   }
   const attributed = files.map((file) => {
    const abs = path.resolve(root, file.path);
    const owner = sources.find((source) => source.kind === 'agent' && abs.startsWith(`${path.resolve(source.root)}${path.sep}`));
    return { ...file, agentId: owner?.agent_id || null, agentLabel: owner?.label || null };
   });

   res.json({ data: { root, branch, files: attributed }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.get('/backend/workspaces/:id/git/diff', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const relativePath = String(req.query.path || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   if (!relativePath) return jsonError(res, 400, new Error('path is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const root = gitRootOf(await fetchWorkspaceRow(workspaceId));
   if (!root) return jsonError(res, 404, new Error('Workspace has no project path configured'));
   const target = resolveWithinRoot(root, relativePath);
   if (!target) return jsonError(res, 400, new Error('path must stay within the workspace project root'));

   // Untracked files have no HEAD to diff against — `git diff` is silent for
   // them, so surface the working-tree content directly (capped) instead.
   let isUntracked = false;
   try {
    const { stdout } = await execFileAsync(
     'git', ['-C', root, 'status', '--porcelain=v1', '-z', '--', relativePath],
     { timeout: 5000 },
    );
    isUntracked = stdout.startsWith('??');
   } catch {
    // fall through to diff attempt below
   }

   if (isUntracked) {
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
     return jsonError(res, 404, new Error('File not found'));
    }
    // This branch reads raw file content (unlike the git-diff branch below,
    // which stays inside git's own repository boundary via `git diff`), so a
    // symlink inside the workspace root pointing outside it would otherwise
    // let an attacker read arbitrary files on the host. `resolveWithinRoot`
    // above already realpath-validates `target` against `root`, so it's safe
    // to read directly here.
    const content = fs.readFileSync(target, 'utf8').slice(0, 200_000);
    return res.json({ data: { path: relativePath, untracked: true, diff: '', content }, error: null });
   }

   const { stdout } = await execFileAsync(
    'git', ['-C', root, 'diff', 'HEAD', '--', relativePath],
    { timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
   );
   res.json({ data: { path: relativePath, untracked: false, diff: stdout, content: '' }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Resolves a workspace's git root for a write (stage/unstage/commit) request:
 // checks 'write' capability (stricter than the read-only status/diff routes
 // above) and 404s if the workspace has no project path configured.
 async function requireWritableGitRoot(req, workspaceId) {
  await enforceWorkspaceRole(req.userId, workspaceId, 'write');
  const root = gitRootOf(await fetchWorkspaceRow(workspaceId));
  if (!root || !fs.existsSync(root)) {
   const error = new Error('Workspace has no project path configured');
   error.status = 404;
   throw error;
  }
  return root;
 }

 // Normalizes a stage/unstage request body into a validated list of paths
 // resolved within the workspace root — reuses the same traversal guard the
 // read-only diff endpoint relies on.
 function resolveStagePaths(root, body) {
  const raw = Array.isArray(body?.paths) ? body.paths : (body?.path !== undefined ? [body.path] : []);
  const relativePaths = raw.map((value) => String(value || '').trim()).filter(Boolean);
  if (relativePaths.length === 0) throw badRequest('path or paths is required');
  for (const relativePath of relativePaths) {
   if (!resolveWithinRoot(root, relativePath)) throw badRequest('path must stay within the workspace project root');
  }
  return relativePaths;
 }

 app.post('/backend/workspaces/:id/git/stage', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   const root = await requireWritableGitRoot(req, workspaceId);
   const relativePaths = resolveStagePaths(root, req.body);
   await execFileAsync('git', ['-C', root, 'add', '--', ...relativePaths], { timeout: 8000 });
   res.json({ data: { staged: relativePaths }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/git/unstage', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   const root = await requireWritableGitRoot(req, workspaceId);
   const relativePaths = resolveStagePaths(root, req.body);
   await execFileAsync('git', ['-C', root, 'reset', 'HEAD', '--', ...relativePaths], { timeout: 8000 });
   res.json({ data: { unstaged: relativePaths }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:id/git/commit', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   const message = String(req.body?.message || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   if (!message) return jsonError(res, 400, new Error('A commit message is required'));
   const root = await requireWritableGitRoot(req, workspaceId);

   const { stdout: stagedOut } = await execFileAsync('git', ['-C', root, 'diff', '--cached', '--name-only'], { timeout: 5000 });
   if (!stagedOut.trim()) return jsonError(res, 400, new Error('No staged changes to commit'));

   const userRows = await getDb().unsafe('select email, display_name from app_users where id = $1 limit 1', [req.userId]);
   const committer = userRows[0] || {};
   const authorName = String(committer.display_name || '').trim() || String(committer.email || '').split('@')[0] || 'Agensis user';
   const authorEmail = String(committer.email || 'agensis@local').trim();

   const { stdout } = await execFileAsync(
    'git',
    ['-C', root, '-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`, 'commit', '-m', message],
    { timeout: 10000 },
   );
   const { stdout: shaOut } = await execFileAsync('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 5000 });
   res.json({ data: { sha: shaOut.trim(), summary: stdout.trim() }, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 // Netlify deploy-notification receiver. Point a Netlify "Deploy succeeded"
 // outgoing webhook at this URL; when a new frontend publishes to the CDN, Netlify
 // POSTs the deploy object here and we fan a `deploy_published` system event to every
 // connected client so the app can offer a "new version — reload" nudge. Public by
 // design (Netlify has no bearer token); authenticity comes from the JWS signature.
 //
 // Fast-ack: everything here is synchronous in-memory (HMAC + one socket loop, no DB,
 // no outbound calls), so we always respond quickly. Netlify silently disables hooks
 // whose receiver is slow or errors on ITS legitimate requests — a correctly-signed
 // request always reaches the 200 below; only forgeries get a 401, which cannot
 // disable the real hook.
}

module.exports = { mountProjectGitRoutes };
