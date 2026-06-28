// Config resolution: a JSON file (./agensis-cli.json or ~/.agensis/agent.json),
// overlaid by env vars and CLI flags / a --join blob. The join blob carries the
// MCP url + token (+ optional channel) so a user can paste one command.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export const GLOBAL_CONFIG = join(homedir(), ".agensis", "agent.json");
export const LOCAL_CONFIG = "agensis-cli.json";

/** Decode a base64url join blob → { url, token, channelId }, or null. */
export function decodeJoin(blob) {
  try {
    const b64 = String(blob).trim().replace(/-/g, "+").replace(/_/g, "/");
    const json = Buffer.from(b64, "base64").toString("utf8");
    const o = JSON.parse(json);
    if (!o.u || !o.t) return null;
    return { url: o.u, token: o.t, channelId: o.c };
  } catch {
    return null;
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** First config file that exists: explicit path → ./agensis-cli.json → ~/.agensis/agent.json. */
export function findConfigPath(explicit) {
  if (explicit) return explicit;
  if (existsSync(LOCAL_CONFIG)) return LOCAL_CONFIG;
  if (existsSync(GLOBAL_CONFIG)) return GLOBAL_CONFIG;
  return null;
}

const DEFAULTS = {
  url: "https://agensis.io/api/mcp",
  token: "",
  channelId: "", // when set, watch only this channel (the per-channel override)
  repos: {},
  // acceptEdits lets the CLI make file edits without prompting (bias to action);
  // it still won't run arbitrary commands. Override in agensis-cli.json if you
  // want a stricter (or `--dangerously-skip-permissions`) command.
  codingCmd: "claude -p --permission-mode acceptEdits",
  // Chat replies + the code-task plan-ack use a FAST one-shot model so a casual
  // reply (or "I see it, here's my plan") comes back in seconds, not minutes.
  // Bounded by chatTimeoutMs with a template fallback so it can never dead-air.
  // If your coding stack isn't Claude, set this to your own fast reply command.
  chatCmd: "claude -p --model claude-haiku-4-5",
  defaultBranch: "main",
  // Bias to action: open a PR directly for review (approve = merge on the card).
  // Set gate:true for the older approve-before-push flow (propose a diff, wait).
  gate: false,
  maxRounds: 3,
  pollMs: 5000,
  // On a long code run, post ONE thread progress reply at the first beat then
  // edit it on later beats, so a human sees the agent is alive without thread
  // spam. 0 disables. Clamped to >=15s so a misconfig can't spam realtime
  // UPDATEs. (Distinct from cli.mjs's 15s LOCAL terminal heartbeat.)
  heartbeatMs: 180000,
  // Cap a chat reply / plan-ack so a stalled model can't dead-air the channel;
  // on timeout we post an honest "taking longer than expected" line.
  chatTimeoutMs: 90000,
  // Work queue: run mentions one at a time (concurrency 1 — parallel CLI runs on
  // one checkout would collide on git state). queueAcks posts "queued behind the
  // current task" when a mention lands during a run; set false to keep it quiet.
  queueConcurrency: 1,
  queueAcks: true,
  runTimeoutMs: 600000,
  decisionTimeoutMs: 1800000,
  decisionPollMs: 5000,
  backfill: false,
  once: false,
};

/** Merge defaults ← file ← env ← join ← flags into one config object. */
export function resolveConfig({ flags = {}, join: joinPayload } = {}) {
  const file = readJson(findConfigPath(flags.config)) || {};
  const env = {
    url: process.env.AGENSIS_URL,
    token: process.env.AGENSIS_TOKEN,
    channelId: process.env.AGENSIS_CHANNEL,
    codingCmd: process.env.CODING_CMD,
    chatCmd: process.env.AGENSIS_CHAT_CMD,
    heartbeatMs: process.env.AGENSIS_HEARTBEAT_MS ? Number(process.env.AGENSIS_HEARTBEAT_MS) : undefined,
    chatTimeoutMs: process.env.AGENSIS_CHAT_TIMEOUT_MS ? Number(process.env.AGENSIS_CHAT_TIMEOUT_MS) : undefined,
    backfill: process.env.AGENSIS_BACKFILL === "1" ? true : undefined,
    once: process.env.AGENSIS_ONCE === "1" ? true : undefined,
  };
  const merged = { ...DEFAULTS, ...file };
  for (const [k, v] of Object.entries(env)) if (v !== undefined && v !== "") merged[k] = v;
  // Clamp the chat heartbeat: 0 (off) stays off, otherwise never below 15s.
  if (merged.heartbeatMs > 0) merged.heartbeatMs = Math.max(15000, Number(merged.heartbeatMs) || 0);
  if (joinPayload) {
    merged.url = joinPayload.url;
    merged.token = joinPayload.token;
    if (joinPayload.channelId) merged.channelId = joinPayload.channelId;
  }
  for (const [k, v] of Object.entries(flags)) if (v !== undefined) merged[k] = v;
  merged.repos = { ...DEFAULTS.repos, ...(file.repos || {}) };
  // Remember where the file lives so reloadConfig can re-read it live.
  merged.configPath = findConfigPath(flags.config) || null;
  return merged;
}

// Run-behavior fields that may change live (edit agensis-cli.json, no restart).
// Connection identity (url/token/channelId) is deliberately excluded so a bad or
// edited file can NEVER drop the daemon's connection.
const LIVE_FIELDS = [
  "codingCmd",
  "chatCmd",
  "defaultBranch",
  "gate",
  "maxRounds",
  "pollMs",
  "runTimeoutMs",
  "decisionTimeoutMs",
  "decisionPollMs",
  "heartbeatMs",
  "chatTimeoutMs",
  // NOT queueConcurrency: the queue is built once at startup, so it can't change
  // live. queueAcks IS live (intake() reads it per-mention from liveCfg).
  "queueAcks",
];

/**
 * Re-read the config file and overlay ONLY the run-behavior fields onto the
 * previous config, so a running daemon picks up model/permission/codingCmd edits
 * without a restart. Identity (url/token/channelId) is pinned from `prev`. Env
 * still overrides (operator wins). On any read error, returns `prev` unchanged.
 */
export function reloadConfig(prev) {
  // Only ever re-read the file CHOSEN AT LAUNCH. A daemon started without a config
  // file (e.g. `--join` + env) stays file-free — we don't re-discover cwd each
  // poll, so an agensis-cli.json dropped in later can't start steering which binary
  // the daemon spawns. (Restart to adopt a newly-created file.)
  const path = prev.configPath;
  const file = (path && readJson(path)) || {};
  const next = { ...prev };
  for (const k of LIVE_FIELDS) if (file[k] !== undefined) next[k] = file[k];
  if (process.env.CODING_CMD) next.codingCmd = process.env.CODING_CMD;
  if (process.env.AGENSIS_CHAT_CMD) next.chatCmd = process.env.AGENSIS_CHAT_CMD;
  if (process.env.AGENSIS_HEARTBEAT_MS) next.heartbeatMs = Number(process.env.AGENSIS_HEARTBEAT_MS);
  if (process.env.AGENSIS_CHAT_TIMEOUT_MS) next.chatTimeoutMs = Number(process.env.AGENSIS_CHAT_TIMEOUT_MS);
  if (next.heartbeatMs > 0) next.heartbeatMs = Math.max(15000, Number(next.heartbeatMs) || 0);
  if (file.repos) next.repos = { ...DEFAULTS.repos, ...file.repos };
  return next;
}

/** Write a starter config file (used by `agensis-cli init`). */
export function writeStarterConfig(path, partial = {}) {
  const target = path || GLOBAL_CONFIG;
  mkdirSync(dirname(target), { recursive: true });
  const starter = {
    url: partial.url || DEFAULTS.url,
    token: partial.token || "",
    channelId: partial.channelId || "",
    repos: partial.repos || { "owner/name": "/absolute/path/to/checkout" },
    codingCmd: partial.codingCmd || DEFAULTS.codingCmd,
    defaultBranch: DEFAULTS.defaultBranch,
    // false = open a PR directly (bias to action); true = approve-before-push.
    gate: false,
  };
  writeFileSync(target, JSON.stringify(starter, null, 2) + "\n");
  return target;
}
