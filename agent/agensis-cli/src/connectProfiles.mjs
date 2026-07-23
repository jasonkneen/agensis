import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_PROFILE = "default";
const PROFILE_VERSION = 2;
const PROFILE_RE = /^[a-zA-Z0-9_.-]{1,64}$/;
const PROFILE_KEYS = [
  "url",
  "token",
  "workspace",
  "agent",
  "handle",
  "name",
  "cwd",
  "codingCmd",
  "model",
  "permissionMode",
  "timeoutMs",
  "heartbeatMs",
  "maxConcurrency",
  "share",
  "sharedModelsFile",
  "noCoding",
  "leanCli",
  "fullCliContext",
  "lanListener",
  "primaryDaemon",
  "cursorBuddyBridge",
  "cursorBuddyPort",
  "hostFolders",
];

export function daemonProfileName(value = DEFAULT_PROFILE) {
  const name = String(value || DEFAULT_PROFILE).trim();
  if (!PROFILE_RE.test(name)) {
    throw new Error("Daemon profile names may only contain letters, numbers, dot, dash, and underscore.");
  }
  return name;
}

export function daemonProfilePath(name = DEFAULT_PROFILE, options = {}) {
  const home = options.homedir || os.homedir();
  return path.join(home, ".agensis", "daemon-profiles", `${daemonProfileName(name)}.json`);
}

function pickedDaemonArgs(config = {}) {
  const out = {};
  for (const key of PROFILE_KEYS) {
    const value = config[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

function requiredValue(args, keys, envNames = []) {
  for (const key of keys) {
    if (String(args?.[key] || "").trim()) return true;
  }
  for (const envName of envNames) {
    if (String(process.env[envName] || "").trim()) return true;
  }
  return false;
}

export function hasDaemonConnectionMaterial(args = {}) {
  return Boolean(
    requiredValue(args, ["url", "baseUrl"], ["AGENSIS_URL"]) ||
    requiredValue(args, ["token"], ["AGENSIS_TOKEN"]) ||
    requiredValue(args, ["workspace", "workspaceId"], ["AGENSIS_WORKSPACE", "AGENSIS_WORKSPACE_ID"]) ||
    requiredValue(args, ["agent", "agentId"], ["AGENSIS_AGENT", "AGENSIS_AGENT_ID"])
  );
}

export function hasCompleteDaemonConnection(args = {}) {
  return Boolean(
    requiredValue(args, ["url", "baseUrl"], ["AGENSIS_URL"]) &&
    requiredValue(args, ["token"], ["AGENSIS_TOKEN"]) &&
    requiredValue(args, ["workspace", "workspaceId"], ["AGENSIS_WORKSPACE", "AGENSIS_WORKSPACE_ID"]) &&
    requiredValue(args, ["agent", "agentId"], ["AGENSIS_AGENT", "AGENSIS_AGENT_ID"])
  );
}

export async function readDaemonProfile(name = DEFAULT_PROFILE, options = {}) {
  const filePath = daemonProfilePath(name, options);
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Daemon profile "${daemonProfileName(name)}" is unreadable: ${error?.message || error}`);
  }
  const config = parsed?.config;
  if (!config?.url || !config?.token || !config?.workspace || !config?.agent) return null;
  const picked = pickedDaemonArgs(config);
  // Version 1 persisted the old default of 8 even when the operator never chose
  // it. Migrate that legacy value to the safer default; version 2 values are
  // intentional and remain untouched.
  if (Number(parsed.version || 1) < PROFILE_VERSION && Number(picked.maxConcurrency) === 8) {
    picked.maxConcurrency = 2;
  }
  return picked;
}

export async function writeDaemonProfile(name = DEFAULT_PROFILE, config = {}, options = {}) {
  const picked = pickedDaemonArgs(config);
  if (!picked.url || !picked.token || !picked.workspace || !picked.agent) return null;
  const filePath = daemonProfilePath(name, options);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    version: PROFILE_VERSION,
    savedAt: new Date().toISOString(),
    profile: daemonProfileName(name),
    tokenHash: crypto.createHash("sha256").update(picked.token).digest("hex"),
    config: picked,
  };
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => { });
  return filePath;
}

export function mergeDaemonProfile(profile, args = {}) {
  const merged = { ...profile, ...pickedDaemonArgs(args), command: "connect" };
  if (args.fullCliContext === true) merged.leanCli = false;
  if (args.codingCmd !== undefined && args.noCoding === undefined) merged.noCoding = false;
  if (args.cursorBuddyBridge === undefined && !merged.primaryDaemon) {
    merged.cursorBuddyBridge = false;
  }
  if (args.once !== undefined) merged.once = args.once;
  if (args.exitOnOnce !== undefined) merged.exitOnOnce = args.exitOnOnce;
  return merged;
}

export function daemonProfileSetupMessage(name = DEFAULT_PROFILE) {
  const profile = daemonProfileName(name);
  return [
    `No saved Agensis daemon profile found for "${profile}".`,
    "",
    "To connect the main agent once:",
    "1. Run: agensis setup",
    "2. Sign in or create an account in the browser.",
    "3. Approve this machine as your primary local agent.",
    "",
    "Manual fallback: open Agensis > AI Agents, copy a connection command,",
    "and run that full agensis connect command from the repo folder.",
    "",
    "After the daemon registers successfully, this CLI saves the profile locally.",
    `Then restart it with: agensis connect${profile === DEFAULT_PROFILE ? "" : ` --profile ${profile}`}`,
  ].join("\n");
}
