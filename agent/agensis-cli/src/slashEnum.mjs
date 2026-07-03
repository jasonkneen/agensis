import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Enumerate the slash commands and skills THIS machine exposes, so the daemon can
// push them up with its capability sync. The web composer can only see the fly
// server's filesystem via /backend/system/capabilities — never the user's — so the
// real `.claude/commands` and skills have to ride the daemon's capability push.
//
// Layout (grounded in a real ~/.claude):
//   ~/.claude/commands/*.md            → loose command      (parent: null)
//   ~/.claude/commands/<ns>/*.md       → namespaced command (parent: "<ns>")  ← the parent:child case
//   <cwd>/.claude/commands/**          → same, project-scoped
//   ~/.claude/skills/<name>/           → skill (a directory)
//   ~/.claude/skills/<name>.md         → skill (a single file)
// Symlinked .md files (common — e.g. a command symlinked out of a skill repo) are
// treated as commands.

function safeIsDir(fullPath) {
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return false;
  }
}

function readDirents(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    // Directory doesn't exist / not readable — skip.
    return [];
  }
}

// [{ name, parent }] — parent null for loose commands, the folder name for the
// one-level-namespaced ones. Deduped across roots (home wins first-seen order).
export function detectCommandEntries({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const roots = [
    home && path.join(home, ".claude", "commands"),
    cwd && path.join(cwd, ".claude", "commands"),
  ].filter(Boolean);

  const seen = new Set();
  const entries = [];
  const add = (name, parent) => {
    if (!name) return;
    const key = parent ? `${parent}:${name}` : name;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name, parent: parent || null });
  };

  for (const root of roots) {
    for (const ent of readDirents(root)) {
      if (ent.name.startsWith(".")) continue;
      if (ent.name.endsWith(".md")) {
        // File or symlink-to-.md → a loose command.
        add(ent.name.slice(0, -3), null);
        continue;
      }
      const full = path.join(root, ent.name);
      if (ent.isDirectory() || (ent.isSymbolicLink() && safeIsDir(full))) {
        // One level of namespacing: each *.md inside becomes <dir>:<file>.
        for (const child of readDirents(full)) {
          if (child.name.startsWith(".")) continue;
          if (child.name.endsWith(".md")) add(child.name.slice(0, -3), ent.name);
        }
      }
    }
  }
  return entries;
}

// Skill names — directories OR single .md files under the skills roots. The old
// detector only matched *.md, so directory-style skills (the common case) were
// invisible; this fixes that.
export function detectSkillNames({ home = os.homedir(), cwd = process.cwd() } = {}) {
  const roots = [
    home && path.join(home, ".claude", "skills"),
    home && path.join(home, ".codex", "skills"),
    cwd && path.join(cwd, ".claude", "skills"),
  ].filter(Boolean);

  const names = new Set();
  for (const root of roots) {
    for (const ent of readDirents(root)) {
      if (ent.name.startsWith(".")) continue;
      if (ent.name.endsWith(".md")) {
        names.add(ent.name.slice(0, -3));
      } else if (ent.isDirectory() || ent.isSymbolicLink()) {
        names.add(ent.name);
      }
    }
  }
  return [...names].sort();
}
