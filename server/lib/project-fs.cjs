'use strict';

// Host-filesystem allowlist for the project/git routes.
//
// Moved verbatim out of server/index.cjs (Wave 1 of the index.cjs reduction).
// A pure leaf: fs, path and two environment variables. No database, no module
// state, no request objects.
//
// `workspaceProjectFileSources` deliberately did NOT come with these — it needs
// getDb() and slugHandle, so it stays in index.cjs until Wave 2 moves it with
// the project-files routes. Splitting it out here would have meant inventing an
// injection seam for a single caller.
//
// SECURITY: this is the entire gate between a workspace column a 'manage' user
// can write and an fs read / `git -C` on this host. It is on MUST_BE_LINTED for
// that reason — it was covered while it lived in index.cjs and must not lose
// coverage by moving.

const fs = require('fs');
const path = require('path');

const PROJECT_FILE_IGNORE_DIRS = new Set([
 '.git',
 '.hg',
 '.svn',
 'node_modules',
 'dist',
 'build',
 '.next',
 '.nuxt',
 'out',
 'coverage',
 '.agensis_uploads',
 'release',
 '.cache',
 '.turbo',
]);

// F3 (2026-07 review): git_root/local_path are user-writable workspace columns
// (set via the generic /backend/db/workspaces update, gated only on 'manage'),
// and feed straight into fs reads + `git -C <root>` on THIS host. Without an
// allowlist, a workspace admin could point either column at any directory the
// process can read/commit. AGENSIS_PROJECT_ROOTS is a colon-separated list of
// absolute prefixes this host is willing to touch; AGENSIS_ALLOW_PROJECT_FS is
// the opt-in switch (default OFF — e.g. the shared fly.dev backend leaves both
// unset so project/git routes always return their empty payload instead of
// touching disk). A per-user local daemon opts in by setting both.
function projectFsAllowed() {
 return String(process.env.AGENSIS_ALLOW_PROJECT_FS || '').trim() === 'true';
}

function allowedProjectRootPrefixes() {
 return String(process.env.AGENSIS_PROJECT_ROOTS || '')
  .split(':')
  .map(entry => entry.trim())
  .filter(Boolean)
  .map(entry => path.resolve(entry));
}

// Realpath-contained within one of the allowlisted prefixes (mirrors the
// resolveWithinRoot symlink-escape check in server/index.cjs, but against a set
// of roots instead of one path's relative traversal).
function isWithinAllowedProjectRoot(resolvedPath) {
 if (!projectFsAllowed()) return false;
 const prefixes = allowedProjectRootPrefixes();
 if (prefixes.length === 0) return false;
 let real;
 try { real = fs.realpathSync(resolvedPath); } catch { real = resolvedPath; }
 return prefixes.some((prefix) => {
  let realPrefix;
  try { realPrefix = fs.realpathSync(prefix); } catch { realPrefix = prefix; }
  const withSep = realPrefix.endsWith(path.sep) ? realPrefix : `${realPrefix}${path.sep}`;
  return real === realPrefix || real.startsWith(withSep);
 });
}

function workspaceProjectRoot(workspace) {
 const candidate = String(workspace?.git_root || workspace?.local_path || '').trim();
 if (!candidate) return '';
 const resolved = path.resolve(candidate);
 if (!isWithinAllowedProjectRoot(resolved)) return '';
 try {
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return '';
  return resolved;
 } catch {
  return '';
 }
}

function validFileSourceRoot(value) {
 const candidate = String(value || '').trim();
 if (!candidate) return '';
 const resolved = path.resolve(candidate);
 // Same allowlist gate as workspaceProjectRoot — never list arbitrary host dirs
 // just because a daemon reported them as cwd.
 if (!isWithinAllowedProjectRoot(resolved)) return '';
 try {
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return '';
  return resolved;
 } catch {
  return '';
 }
}

function listProjectFiles(root, maxFiles = 300) {
 const files = [];
 const queue = [''];
 while (queue.length > 0 && files.length < maxFiles) {
  const relativeDir = queue.shift();
  const absoluteDir = path.join(root, relativeDir || '');
  let entries = [];
  try {
   entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
  } catch {
   continue;
  }
  entries
   .filter(entry => !entry.name.startsWith('.') || entry.name === '.env.example')
   .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name))
   .forEach(entry => {
    if (files.length >= maxFiles) return;
    const rel = path.join(relativeDir || '', entry.name);
    if (entry.isDirectory()) {
     if (!PROJECT_FILE_IGNORE_DIRS.has(entry.name)) queue.push(rel);
     return;
    }
    if (!entry.isFile()) return;
    const fullPath = path.join(root, rel);
    try {
     const stat = fs.statSync(fullPath);
     files.push({
      path: rel.split(path.sep).join('/'),
      name: entry.name,
      size: stat.size,
      mtime: stat.mtime.toISOString(),
      kind: 'file',
     });
    } catch {
     // ignore files that disappear while listing
    }
   });
 }
 return files;
}

module.exports = {
 PROJECT_FILE_IGNORE_DIRS,
 projectFsAllowed,
 allowedProjectRootPrefixes,
 isWithinAllowedProjectRoot,
 workspaceProjectRoot,
 validFileSourceRoot,
 listProjectFiles,
};
