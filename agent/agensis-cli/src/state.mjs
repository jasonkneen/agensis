// Agent local state files: the daemon writes a small on-disk mirror of this agent's
// runtime under ~/.agensis/<workspace>/<agent>/ so an external watchdog, the human, or
// the agent's own coding subprocess can read/observe live state without the server.
//
// Files (all JSON except soul.md):
//   heartbeat.json  — DAEMON-OWNED liveness. Refreshed on an interval that runs for the
//                     whole process lifetime (independent of the socket) so a watchdog
//                     can tell "daemon dead" (stale ts) from "server unreachable"
//                     (fresh ts, connected:false).
//   soul.md         — DAEMON-OWNED mirror of the server-authoritative soul text.
//   agent.json      — DAEMON-OWNED mirror of the agent config (model, permission, tools…).
//   status.json     — AGENT-OWNED write-back. The coding subprocess overwrites this to
//                     report its own status; the daemon reads it each beat and folds it
//                     into the heartbeat it sends up. The daemon NEVER writes this file,
//                     so there is no self-write feedback loop.
//
// Everything here is best-effort: a failure to create the dir or write a file is logged
// by the caller and never fatal to the agent.

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const STATUS_FILE = "status.json";
const HEARTBEAT_FILE = "heartbeat.json";
const AGENT_FILE = "agent.json";
const SOUL_FILE = "soul.md";

// Caps so an agent can't write a giant status blob that we then ship on every beat.
const MAX_STATUS_BYTES = 8 * 1024;
const MAX_STATUS_FIELD = 400;

// UUIDs in practice, but never trust config blindly: keep path segments to a safe
// charset so a crafted workspace/agent id can't escape the base dir.
function safeSegment(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".") // collapse any dot-run so no ".." can survive in a segment
    .replace(/^[.-]+/, "")
    .slice(0, 96);
  return cleaned || fallback;
}

// Resolve (but do not create) the per-agent state directory.
export function resolveStateDir({ workspace, agent, homedir = os.homedir() } = {}) {
  return path.join(
    homedir,
    ".agensis",
    safeSegment(workspace, "workspace"),
    safeSegment(agent, "agent"),
  );
}

export function statusFilePath(config) {
  return path.join(resolveStateDir(config), STATUS_FILE);
}

// Create the state dir if needed. Returns the dir, or null if it can't be created.
async function ensureStateDir(config) {
  const dir = resolveStateDir(config);
  try {
    await fsp.mkdir(dir, { recursive: true });
    return dir;
  } catch {
    return null;
  }
}

// Atomic write: tmp file + rename, so a reader (watchdog) never observes a half-written
// file. Best-effort — swallows errors and reports success as a boolean.
async function writeFileAtomic(target, contents) {
  const tmp = `${target}.tmp-${process.pid}`;
  try {
    await fsp.writeFile(tmp, contents);
    await fsp.rename(tmp, target);
    return true;
  } catch {
    try {
      await fsp.rm(tmp, { force: true });
    } catch {
      // ignore cleanup failure
    }
    return false;
  }
}

// Write the daemon-owned config mirror (agent.json + soul.md) from the full agent
// payload the server sends on register / config. Fire-and-forget from the caller.
export async function writeAgentMirror(config, agent) {
  if (!agent || typeof agent !== "object") return false;
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  const mirror = {
    id: agent.id ?? config.agent ?? "",
    workspace: agent.workspace_id ?? config.workspace ?? "",
    name: agent.name ?? config.name ?? "",
    handle: agent.handle ?? config.handle ?? "",
    model: agent.model ?? config.model ?? "",
    permissionMode: agent.permissionMode ?? agent.permission_mode ?? config.permissionMode ?? "",
    description: agent.description ?? "",
    instructions: agent.instructions ?? "",
    systemPrompt: agent.system_prompt ?? agent.systemPrompt ?? "",
    tools: Array.isArray(agent.tools) ? agent.tools : [],
    skills: Array.isArray(agent.skills) ? agent.skills : [],
    memoryDir: agent.memory_dir ?? agent.memoryDir ?? "",
    version: Number(agent.version || 0),
    updatedAt: new Date().toISOString(),
  };
  const okAgent = await writeFileAtomic(
    path.join(dir, AGENT_FILE),
    `${JSON.stringify(mirror, null, 2)}\n`,
  );
  const soul = String(agent.soul ?? "");
  const okSoul = await writeFileAtomic(path.join(dir, SOUL_FILE), soul);
  return okAgent && okSoul;
}

// Write the daemon-owned liveness file. `beat` is the current liveness snapshot; we add
// a timestamp so a stale file is detectable. Async atomic write for regular beats.
export async function writeHeartbeatFile(config, beat = {}) {
  const dir = await ensureStateDir(config);
  if (!dir) return false;
  return writeFileAtomic(path.join(dir, HEARTBEAT_FILE), heartbeatContents(config, beat));
}

// Synchronous variant for the final "stopped" beat written during shutdown, so it lands
// before the process exits (an async write can be cut off by process.exit).
export function writeHeartbeatFileSync(config, beat = {}) {
  const dir = resolveStateDir(config);
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, HEARTBEAT_FILE), heartbeatContents(config, beat));
    return true;
  } catch {
    return false;
  }
}

function heartbeatContents(config, beat) {
  const now = Date.now();
  const payload = {
    ts: now,
    iso: new Date(now).toISOString(),
    status: beat.status || (beat.busy ? "busy" : "online"),
    busy: Boolean(beat.busy),
    active: Number(beat.active || 0),
    queueSize: Number(beat.queueSize || 0),
    connected: Boolean(beat.connected),
    model: config.model || "",
    permissionMode: config.permissionMode || "",
    handle: config.handle || "",
    agent: config.agent || "",
    workspace: config.workspace || "",
    pid: process.pid,
    heartbeatMs: config.heartbeatMs,
    ...(beat.agentStatus ? { agentStatus: beat.agentStatus } : {}),
    ...(beat.agentNote ? { agentNote: beat.agentNote } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// Read the AGENT-OWNED status.json. Returns { status, note, ts } or null when the file is
// absent, unreadable, too big, or malformed. Never throws. Fields are clamped so a
// runaway agent can't bloat the heartbeat we ship upstream.
export async function readAgentStatus(config) {
  const file = path.join(resolveStateDir(config), STATUS_FILE);
  let raw;
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile() || stat.size > MAX_STATUS_BYTES) return null;
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const status = clampField(parsed.status);
  const note = clampField(parsed.note ?? parsed.message);
  if (!status && !note) return null;
  const out = {};
  if (status) out.status = status;
  if (note) out.note = note;
  if (parsed.ts != null && Number.isFinite(Number(parsed.ts))) out.ts = Number(parsed.ts);
  return out;
}

function clampField(value) {
  if (value == null) return "";
  const text = String(value).trim().replace(/\s+/g, " ");
  return text.slice(0, MAX_STATUS_FIELD);
}
