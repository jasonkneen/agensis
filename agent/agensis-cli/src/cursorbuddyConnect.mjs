import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { AGENSIS_CLI_VERSION } from "./agensis.mjs";

export const CURSORBUDDY_KEY_RE = /^cbk_[a-z0-9_]+_[A-Z2-9]{18}$/;

export function backendBaseUrl(args = {}) {
  return String(args.url || args.baseUrl || process.env.AGENSIS_URL || "https://agensis.io")
    .trim()
    .replace(/\/+$/, "");
}

export function cursorBuddyKeyCachePath(key, options = {}) {
  const home = options.homedir || os.homedir();
  const keyHash = crypto.createHash("sha256").update(String(key)).digest("hex");
  return path.join(home, ".agensis", "cursorbuddy", "connection-keys", `${keyHash}.json`);
}

function connectionKeyError() {
  return new Error("Missing or invalid --key. Create a CursorBuddy connection key in Agensis first.");
}

function validateConnectionKey(key) {
  const normalized = String(key || "").trim();
  if (!CURSORBUDDY_KEY_RE.test(normalized)) throw connectionKeyError();
  return normalized;
}

function normalizeDaemonArgs(args, data, baseUrl, cwd) {
  const token = data?.token;
  const workspace = data?.workspaceId || data?.workspace_id || data?.agent?.workspace_id;
  const agent = data?.agentId || data?.agent?.id;
  if (!token || !workspace || !agent) {
    throw new Error("CursorBuddy key claim did not return a complete daemon connection payload");
  }

  const { key: _key, subcommand: _subcommand, ...runtimeArgs } = args;
  return {
    ...runtimeArgs,
    command: "connect",
    url: data.baseUrl || baseUrl,
    token,
    workspace,
    agent,
    handle: data.handle || args.handle,
    name: data.agent?.name || args.name || "CursorBuddy runtime",
    model: data.model || args.model,
    permissionMode: data.permissionMode || data.permission_mode || args.permissionMode,
    cwd: args.cwd || cwd,
    cursorBuddyRuntime: true,
  };
}

export async function readCachedCursorBuddyDaemonArgs(key, options = {}) {
  validateConnectionKey(key);
  const filePath = cursorBuddyKeyCachePath(key, options);
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
    throw new Error(`Cached CursorBuddy daemon config is unreadable: ${error?.message || error}`);
  }

  const daemonArgs = parsed?.daemonArgs;
  if (!daemonArgs?.token || !daemonArgs?.workspace || !daemonArgs?.agent || !daemonArgs?.url) {
    return null;
  }
  return daemonArgs;
}

export async function writeCachedCursorBuddyDaemonArgs(key, daemonArgs, options = {}) {
  validateConnectionKey(key);
  if (!daemonArgs?.token || !daemonArgs?.workspace || !daemonArgs?.agent || !daemonArgs?.url) return;

  const filePath = cursorBuddyKeyCachePath(key, options);
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = {
    version: 1,
    savedAt: new Date().toISOString(),
    keyHash: path.basename(filePath, ".json"),
    daemonArgs,
  };
  await fs.writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
  await fs.chmod(filePath, 0o600).catch(() => {});
}

function mergeCachedDaemonArgs(cached, args, cwd) {
  const merged = { ...cached, command: "connect" };
  for (const key of [
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
    "lanListener",
    "once",
  ]) {
    if (args[key] !== undefined) merged[key] = args[key];
  }
  if (args.codingCmd !== undefined && args.noCoding === undefined) merged.noCoding = false;
  if (!merged.cwd) merged.cwd = cwd;
  merged.cursorBuddyRuntime = true;
  return merged;
}

function responseErrorMessage(response, body) {
  return body?.error?.message || body?.message || `CursorBuddy key claim failed with HTTP ${response.status}`;
}

async function readResponseJson(response) {
  return response.json().catch(() => ({}));
}

export async function claimCursorBuddyConnectionKey(args, deps = {}) {
  const key = validateConnectionKey(args?.key);
  const baseUrl = backendBaseUrl(args);
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node.js runtime does not provide fetch; use a current Node.js release.");
  }
  const cwd = deps.cwd || process.cwd();
  const hostname = deps.hostname || os.hostname();
  const version = deps.version || AGENSIS_CLI_VERSION;
  const cacheOptions = { homedir: deps.homedir };

  const response = await fetchImpl(`${baseUrl}/backend/cursorbuddy/connection-keys/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key,
      baseUrl,
      host: hostname,
      cwd: args.cwd || cwd,
      name: args.name,
      surface: args.surface || "local_cli",
      scope: args.scope || "machine",
      runtimeKind: "agensis-cli",
      version,
      permissionMode: args.permissionMode,
      model: args.model,
    }),
  });

  const body = await readResponseJson(response);
  if (!response.ok) {
    const message = responseErrorMessage(response, body);
    if (response.status === 409 || /already been claimed/i.test(message)) {
      const cached = await readCachedCursorBuddyDaemonArgs(key, cacheOptions);
      if (cached) return mergeCachedDaemonArgs(cached, args, cwd);
      throw new Error(`${message}. No cached daemon config was found on this machine; create a new CursorBuddy key in Agensis or run the full copied agensis connect command.`);
    }
    throw new Error(message);
  }

  const daemonArgs = normalizeDaemonArgs(args, body?.data || body, baseUrl, cwd);
  await writeCachedCursorBuddyDaemonArgs(key, daemonArgs, cacheOptions);
  return daemonArgs;
}
