// Agent file-memory: enumerate + read the memory palace files this daemon's agent
// uses, so the app can mirror them (read-only) in the Memory section.
//
// SECURITY: this exposes filesystem reads to the web UI via the daemon. Every read
// is constrained to a single root (the derived palace dir or an explicit memory_dir):
// the root is realpath'd, every target is realpath'd, and a target is only allowed if
// it resolves to inside the root. Reads only — nothing here writes.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Caps so a runaway palace can't blow up memory or the WS frame.
const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024; // 256 KB per file
const MAX_DEPTH = 2;
const MEMORY_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

// Claude Code stores a project's memory palace at
//   ~/.claude/projects/<slug>/memory/
// where <slug> is the project cwd with every non-alphanumeric char replaced by '-'.
// e.g. /Users/jkneen/Documents/GitHub/agensis -> -Users-jkneen-Documents-GitHub-agensis
export function projectSlug(cwd) {
  return String(cwd || "").replace(/[^a-zA-Z0-9]/g, "-");
}

// Resolve the memory root for an agent. An explicit memory_dir (absolute, or ~-relative)
// wins; otherwise derive the Claude palace path from cwd. Returns null when we have
// nothing to go on.
export function deriveMemoryRoot({ cwd, memoryDir, homedir = os.homedir() } = {}) {
  const override = String(memoryDir || "").trim();
  if (override) {
    if (override.startsWith("~")) return path.join(homedir, override.slice(1));
    return path.resolve(override);
  }
  const c = String(cwd || "").trim();
  if (!c) return null;
  return path.join(homedir, ".claude", "projects", projectSlug(c), "memory");
}

// Realpath the root once. Returns null if it doesn't exist (agent has no palace yet).
async function realRoot(root) {
  if (!root) return null;
  try {
    const resolved = await fs.realpath(root);
    const stat = await fs.stat(resolved);
    return stat.isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

// Resolve `target` and require it to live inside `realRootPath`. Throws on any escape
// (traversal, absolute path elsewhere, symlink pointing out). `target` may be absolute
// or relative-to-root. The file must exist (realpath resolves symlinks).
export async function resolveWithinRoot(realRootPath, target) {
  if (!realRootPath) throw new Error("memory root unavailable");
  const candidate = path.isAbsolute(String(target))
    ? String(target)
    : path.join(realRootPath, String(target));
  const resolved = await fs.realpath(candidate); // throws if missing
  const prefix = realRootPath.endsWith(path.sep) ? realRootPath : realRootPath + path.sep;
  if (resolved !== realRootPath && !resolved.startsWith(prefix)) {
    throw new Error(`path escapes memory root: ${target}`);
  }
  return resolved;
}

function classify(relPath) {
  const base = path.basename(relPath).toLowerCase();
  if (base === "memory.md") return "index";
  if (base === "claude.md") return "instructions";
  return "memory";
}

// Walk the root (depth-capped) collecting memory files: { path (relative), kind }.
async function walk(realRootPath, dir, depth, out) {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) break;
    if (entry.name.startsWith(".")) continue; // skip dotfiles/dirs
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(realRootPath, abs, depth + 1, out);
    } else if (entry.isFile() && MEMORY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      const rel = path.relative(realRootPath, abs);
      out.push({ path: rel, kind: classify(rel) });
    }
  }
}

export async function enumerateMemoryFiles(root) {
  const realRootPath = await realRoot(root);
  if (!realRootPath) return [];
  const out = [];
  await walk(realRootPath, realRootPath, 0, out);
  out.sort((a, b) => (a.kind === "index" ? -1 : b.kind === "index" ? 1 : a.path.localeCompare(b.path)));
  return out;
}

// Read one file's content (allowlisted, truncated to MAX_FILE_BYTES).
export async function readMemoryFile(root, relPath) {
  const realRootPath = await realRoot(root);
  const resolved = await resolveWithinRoot(realRootPath, relPath);
  const buf = await fs.readFile(resolved);
  const truncated = buf.length > MAX_FILE_BYTES;
  const content = buf.subarray(0, MAX_FILE_BYTES).toString("utf8");
  return { content, byteSize: buf.length, truncated };
}

// Cheap drift fingerprint: enumerate the palace and stat each file (path + size +
// mtime) WITHOUT reading contents, so this is safe to run on every heartbeat. Returns
// a stable canonical string; the daemon hashes it and the server compares that hash to
// the last synced value to decide whether a full snapshot re-push is needed. Empty
// string when there is no palace (nothing to mirror).
export async function memoryFingerprint(root) {
  const realRootPath = await realRoot(root);
  if (!realRootPath) return "";
  const files = [];
  await walk(realRootPath, realRootPath, 0, files);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const parts = [];
  for (const file of files) {
    try {
      const s = await fs.stat(path.join(realRootPath, file.path));
      parts.push(`${file.path}:${s.size}:${Math.floor(s.mtimeMs)}`);
    } catch {
      // vanished between enumerate and stat — skip
    }
  }
  return parts.join("|");
}

// Full snapshot the daemon pushes up: every memory file with its content.
export async function snapshotMemory(root) {
  const files = await enumerateMemoryFiles(root);
  const result = [];
  for (const file of files) {
    try {
      const { content, byteSize } = await readMemoryFile(root, file.path);
      result.push({ path: file.path, kind: file.kind, content, byteSize });
    } catch {
      // Skip files that vanish or fail the allowlist between enumerate and read.
    }
  }
  return result;
}
