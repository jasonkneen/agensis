import os from "node:os";
import process from "node:process";
import WebSocket from "ws";
import { runCli } from "./cli.mjs";
import { createQueue } from "./queue.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 15 * 1000;
const DEFAULT_MODEL = "claude-opus-4-8";

export async function runAgensisDaemon(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  let stopped = false;
  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let acceptedJobCount = 0;
  let resolveWait = null;
  let queue = null;

  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    try {
      ws?.close();
    } catch {
      // ignore close races
    }
    if (resolveWait) resolveWait();
  };

  queue = createQueue({
    runJob: async (job, ctx) => {
      await runAgentJob(config, job, ctx);
      if (config.once) stop();
    },
  });

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const connect = () => {
    if (stopped) return;
    const url = socketUrl(config.url, config.token);
    log(`Connecting to ${url.replace(config.token, "redacted")}`);
    ws = new WebSocket(url);

    ws.on("open", () => {
      log(`Connected. Registering @${config.handle || "agent"} from ${config.cwd}`);
      send(ws, {
        action: "agent_register",
        workspaceId: config.workspace,
        agentId: config.agent,
        handle: config.handle,
        name: config.name,
        host: os.hostname(),
        cwd: config.cwd,
        metadata: {
          codingCmd: config.codingCmd,
          model: config.model,
          permissionMode: config.permissionMode,
          permissionFlags: permissionFlagsForMode(config.permissionMode),
          once: config.once,
          runtime: "agensis",
          version: "0.1.0",
        },
      });
      heartbeatTimer = setInterval(() => {
        send(ws, {
          action: "agent_heartbeat",
          metadata: {
            busy: queue.active() > 0,
            queueSize: queue.size(),
            cwd: config.cwd,
            model: config.model,
            permissionMode: config.permissionMode,
            permissionFlags: permissionFlagsForMode(config.permissionMode),
          },
        });
      }, config.heartbeatMs);
      if (heartbeatTimer.unref) heartbeatTimer.unref();
    });

    ws.on("message", (data) => {
      const message = parseMessage(data);
      if (!message) return;
      if (message.type === "agent_registered") {
        applyAgentConfig(config, message.agent);
        log(`Registered as ${message.connection?.name || config.name} on ${message.connection?.host || os.hostname()}`);
        return;
      }
      if (message.type === "agent_config") {
        applyAgentConfig(config, message.agent);
        log(`Updated config for @${config.handle || "agent"}: model=${config.model}, permission=${config.permissionMode}`);
        return;
      }
      if (message.type === "error") {
        log(`Server rejected request: ${message.message || "unknown error"}`);
        return;
      }
      if (message.type === "agent_job" && message.job?.id) {
        const result = queue.enqueue({ ...message.job, key: message.job.id, ws });
        if (result.accepted) {
          acceptedJobCount += 1;
          log(`Queued job ${message.job.id} at position ${result.position}`);
          if (config.once) {
            void queue.idle().then(() => stop());
          }
        }
      }
    });

    ws.on("close", (code, reason) => {
      log(`Socket closed (${code || "no-code"}${reason ? `: ${reason}` : ""})`);
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
      if (config.once && acceptedJobCount > 0 && queue.active() === 0 && queue.size() === 0) {
        stop();
      }
      if (stopped || config.once) return;
      reconnectTimer = setTimeout(connect, 2000);
      if (reconnectTimer.unref) reconnectTimer.unref();
    });

    ws.on("error", (error) => {
      log(`Socket error: ${error?.message || error}`);
    });
  };

  connect();
  await new Promise((resolve) => {
    const poll = setInterval(async () => {
      if (config.once && acceptedJobCount > 0 && queue.active() === 0 && queue.size() === 0) {
        stop();
      }
      if (stopped) {
        stop();
      }
    }, 500);
    resolveWait = () => {
      clearInterval(poll);
      resolve();
    };
  });
  resolveWait = null;
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}

function normalizeConfig(raw) {
  const config = {
    url: String(raw.url || raw.baseUrl || "").trim(),
    token: String(raw.token || "").trim(),
    workspace: String(raw.workspace || raw.workspaceId || "").trim(),
    agent: String(raw.agent || raw.agentId || "").trim(),
    handle: slugHandle(raw.handle || raw.name || "agent"),
    name: String(raw.name || raw.handle || "agensis Agent").trim(),
    cwd: String(raw.cwd || process.cwd()).trim(),
    codingCmd: String(raw.codingCmd || process.env.AGENSIS_CODING_CMD || process.env.CODING_CMD || "claude -p").trim(),
    model: resolveModel(raw.model || process.env.AGENSIS_MODEL || process.env.CLAUDE_MODEL || ""),
    permissionMode: normalizePermissionMode(raw.permissionMode || raw.permission_mode || raw.permission || process.env.AGENSIS_PERMISSION_MODE || "default"),
    timeoutMs: Number(raw.timeoutMs || DEFAULT_TIMEOUT_MS),
    heartbeatMs: Number(raw.heartbeatMs || DEFAULT_HEARTBEAT_MS),
    once: Boolean(raw.once),
    exitOnOnce: Boolean(raw.exitOnOnce),
  };
  const missing = [];
  if (!config.url) missing.push("--url");
  if (!config.token) missing.push("--token");
  if (!config.workspace) missing.push("--workspace");
  if (!config.agent) missing.push("--agent");
  if (missing.length) throw new Error(`Missing required option(s): ${missing.join(", ")}`);
  return config;
}

function socketUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/backend/ws";
  url.search = "";
  url.searchParams.set("agentToken", token);
  return url.toString();
}

async function runAgentJob(config, job, { signal }) {
  const started = Date.now();
  log(`Starting job ${job.id}`);
  const command = buildAgentCommand(config, job);
  const prompt = buildPrompt(config, job);
  let fullContent = "";
  let latest = "";
  let lastDeltaAt = 0;
  const sendDelta = (content = "") => {
    send(job.ws, {
      action: "agent_job_delta",
      jobId: job.id,
      content,
      elapsedMs: Date.now() - started,
      model: command.model,
      permissionMode: command.permissionMode,
      permissionFlags: command.permissionFlags,
    });
  };

  sendDelta("");
  const progressTimer = setInterval(() => sendDelta(fullContent), 1000);
  if (progressTimer.unref) progressTimer.unref();

  const result = await runCli({
    cmd: command.cmd,
    args: [...command.args, prompt],
    cwd: config.cwd,
    timeoutMs: config.timeoutMs,
    heartbeatMs: config.heartbeatMs,
    label: "agent job",
    signal,
    onData: (chunk) => {
      fullContent += String(chunk || "");
      latest = latestLine(`${latest}\n${chunk}`);
      const now = Date.now();
      if (now - lastDeltaAt > 500) {
        lastDeltaAt = now;
        sendDelta(fullContent);
      }
    },
  });
  clearInterval(progressTimer);

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const error = result.error
    ? result.error.message
    : result.status === 0
      ? ""
      : stderr || `Command exited with status ${result.status}`;
  const response = stdout || (error ? "" : stderr) || latest || "";

  send(job.ws, {
    action: "agent_job_result",
    jobId: job.id,
    response,
    error,
    elapsedMs: Date.now() - started,
    model: command.model,
    permissionMode: command.permissionMode,
    permissionFlags: command.permissionFlags,
  });
  log(`Finished job ${job.id} in ${Math.round((Date.now() - started) / 1000)}s`);
  if (config.once) {
    log("One-shot job complete; exiting.");
    setTimeout(() => process.exit(0), 150);
  }
}

function buildPrompt(config, job) {
  const agent = job.agent || {};
  const skills = Array.isArray(agent.skills) ? agent.skills.join(", ") : String(agent.skills || "");
  const tools = Array.isArray(agent.tools) ? agent.tools.join(", ") : String(agent.tools || "");
  const model = resolveJobModel(config, job);
  const permissionMode = resolveJobPermissionMode(config, job);
  const sections = [
    "You are running as a local agensis workspace agent daemon.",
    `Workspace: ${job.workspaceId || config.workspace}`,
    `Channel session: ${job.sessionId || ""}`,
    `Agent: ${agent.name || config.name} (@${agent.handle || config.handle})`,
    `Requested model: ${model}`,
    `Permission mode: ${permissionMode}`,
    agent.description ? `Description:\n${agent.description}` : "",
    agent.soul ? `Soul:\n${agent.soul}` : "",
    agent.system_prompt ? `System instructions:\n${agent.system_prompt}` : "",
    agent.instructions ? `Additional instructions:\n${agent.instructions}` : "",
    tools ? `Enabled tools:\n${tools}` : "",
    skills ? `Enabled skills:\n${skills}` : "",
    "Respond with a clear channel-ready result. If you changed files, summarize the files and verification. If you cannot complete it, say exactly why.",
    "User message:",
    String(job.prompt || ""),
  ];
  return sections.filter(Boolean).join("\n\n");
}

function buildAgentCommand(config, job) {
  const { cmd, args } = splitCommand(config.codingCmd);
  const model = resolveJobModel(config, job);
  const permissionMode = resolveJobPermissionMode(config, job);
  const cleanArgs = stripManagedFlags(args);
  const permissionFlags = permissionFlagsForMode(permissionMode);

  if (isClaudeCommand(cmd)) {
    const nextArgs = [...cleanArgs];
    if (model) nextArgs.push("--model", model);
    if (permissionMode === "accept_edits") nextArgs.push("--permission-mode", "acceptEdits");
    if (permissionMode === "yolo") nextArgs.push("--dangerously-skip-permissions");
    return { cmd, args: nextArgs, model, permissionMode, permissionFlags };
  }

  if (isCodexCommand(cmd)) {
    const nextArgs = [...cleanArgs];
    if (model) nextArgs.push("--model", model);
    if (permissionMode === "yolo") nextArgs.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
    return { cmd, args: nextArgs, model, permissionMode, permissionFlags };
  }

  return { cmd, args, model, permissionMode, permissionFlags };
}

function resolveJobModel(config, job) {
  return resolveModel(job?.agent?.model || job?.model || config.model);
}

function resolveModel(value) {
  const text = String(value || "").trim();
  if (!text || text === "auto" || text === "claude-fable-5") return DEFAULT_MODEL;
  return text;
}

function resolveJobPermissionMode(config, job) {
  return normalizePermissionMode(
    job?.agent?.permissionMode ||
      job?.agent?.permission_mode ||
      job?.permissionMode ||
      job?.permission_mode ||
      config.permissionMode,
  );
}

function normalizePermissionMode(value) {
  const mode = String(value || "").trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["yolo", "no_sandbox", "danger", "danger_full_access", "dangerously_skip_permissions"].includes(mode)) return "yolo";
  if (["accept_edits", "acceptedits", "auto_approve", "auto_approve_edits"].includes(mode)) return "accept_edits";
  return "default";
}

function permissionFlagsForMode(permissionMode) {
  return normalizePermissionMode(permissionMode) === "yolo" ? ["--no-sandbox", "--yolo"] : [];
}

function applyAgentConfig(config, agent) {
  if (!agent || typeof agent !== "object") return;
  if (agent.name) config.name = String(agent.name).trim() || config.name;
  if (agent.handle || agent.name) config.handle = slugHandle(agent.handle || agent.name || config.handle);
  if (agent.model) config.model = resolveModel(agent.model);
  const permissionMode = agent.permissionMode || agent.permission_mode;
  if (permissionMode) config.permissionMode = normalizePermissionMode(permissionMode);
}

function stripManagedFlags(args) {
  const flagsWithValues = new Set(["--model", "-m", "--permission-mode", "--sandbox", "--ask-for-approval", "--approval-policy"]);
  const flagsWithoutValues = new Set(["--dangerously-skip-permissions", "--no-sandbox", "--yolo", "--accept-edits"]);
  const next = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const [flag] = String(arg).split("=", 1);
    if (flagsWithoutValues.has(arg)) continue;
    if (flagsWithValues.has(flag)) {
      if (!String(arg).includes("=")) i += 1;
      continue;
    }
    next.push(arg);
  }
  return next;
}

function isClaudeCommand(cmd) {
  return /(^|\/)claude(?:$|\.)/.test(String(cmd || ""));
}

function isCodexCommand(cmd) {
  return /(^|\/)codex(?:$|\.)/.test(String(cmd || ""));
}

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";
  let escape = false;
  for (const ch of command) {
    if (escape) {
      current += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  if (!parts.length) throw new Error("coding command is empty");
  return { cmd: parts[0], args: parts.slice(1) };
}

function parseMessage(data) {
  try {
    return JSON.parse(String(data));
  } catch {
    return null;
  }
}

function send(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(message));
  return true;
}

function latestLine(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-1)[0] || "";
}

function slugHandle(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/^@+/, "")
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function log(message) {
  process.stderr.write(`[agensis] ${message}\n`);
}
