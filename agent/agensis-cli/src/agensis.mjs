import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import process from "node:process";
import WebSocket from "ws";
import { runCli } from "./cli.mjs";
import { createQueue } from "./queue.mjs";
import { deriveMemoryRoot, snapshotMemory, memoryFingerprint } from "./memory.mjs";
import {
  writeAgentMirror,
  writeHeartbeatFile,
  writeHeartbeatFileSync,
  readAgentStatus,
  statusFilePath,
  ensureHeartbeatMd,
  heartbeatMdPath,
  readHeartbeatMd,
} from "./state.mjs";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_HEARTBEAT_MS = 15 * 1000;
// How many conversations may run at once. Each DM / channel / thread is its own
// serial lane; this caps how many lanes run in parallel so we never spawn an
// unbounded number of coding-CLI subprocesses. Override with --max-concurrency.
const DEFAULT_MAX_CONCURRENCY = 8;
const DEFAULT_MODEL = "claude-opus-4-8";
export const AGENSIS_CLI_VERSION = "0.1.16";

export async function runAgensisDaemon(rawConfig = {}) {
  const config = normalizeConfig(rawConfig);
  let stopped = false;
  let ws = null;
  let reconnectTimer = null;
  let heartbeatTimer = null;
  let fileHeartbeatTimer = null;
  let acceptedJobCount = 0;
  let resolveWait = null;
  let queue = null;
  let lastSocketErrorCode = '';

  const stop = () => {
    stopped = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (fileHeartbeatTimer) clearInterval(fileHeartbeatTimer);
    // Leave the last-known ts in place, but mark the daemon stopped so a watchdog reading
    // heartbeat.json sees an intentional shutdown rather than inferring death from a stale
    // timestamp. Sync so it lands before any process.exit races us.
    writeHeartbeatFileSync(config, { status: "stopped", connected: false });
    try {
      ws?.close();
    } catch {
      // ignore close races
    }
    if (resolveWait) resolveWait();
  };

  queue = createQueue({
    // --once is a one-shot: keep it strictly serial so we run exactly one job
    // then drain. Otherwise run conversations in parallel up to the cap.
    concurrency: config.once ? 1 : config.maxConcurrency,
    runJob: async (job, ctx) => {
      await runAgentJob(config, job, ctx);
      if (config.once) stop();
    },
  });

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const connect = () => {
    if (stopped) return;
    const url = socketUrl(config.url, config.token, config);
    lastSocketErrorCode = '';
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
          version: AGENSIS_CLI_VERSION,
        },
      });
      heartbeatTimer = setInterval(() => {
        // Carry the current capability/memory drift hashes alongside the liveness
        // beat. They ride as distinct top-level fields (NOT inside metadata, which the
        // server merges into the persisted row) so the server can compare them against
        // the last synced values without persisting an unconfirmed candidate hash. On a
        // mismatch the server nudges a full re-push, keeping the agents list fresh.
        // Also fold in the agent-owned status.json (its self-declared status/note) so a
        // running agent can update how it appears without any extra transport.
        void Promise.all([
          computeCapabilities(config).catch(() => null),
          readAgentStatus(config).catch(() => null),
        ]).then(([caps, agentStatus]) => {
          send(ws, {
            action: "agent_heartbeat",
            ...(caps ? { capabilitiesHash: caps.capabilitiesHash, memoryHash: caps.memoryHash } : {}),
            metadata: heartbeatMetadata(config, queue, agentStatus),
          });
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
        void writeAgentMirror(config, message.agent).catch(() => {});
        // Seed heartbeat.md (what to do on each beat) if it doesn't exist yet; never
        // clobbers an existing file, so human/agent edits persist across restarts.
        void ensureHeartbeatMd(config).catch(() => {});
        void pushMemorySnapshot(ws, config);
        void pushCapabilitiesSnapshot(ws, config);
        return;
      }
      if (message.type === "agent_config") {
        applyAgentConfig(config, message.agent);
        log(`Updated config for @${config.handle || "agent"}: model=${config.model}, permission=${config.permissionMode}`);
        void writeAgentMirror(config, message.agent).catch(() => {});
        return;
      }
      if (message.type === "agent_memory_refresh") {
        void pushMemorySnapshot(ws, config);
        // Re-push capabilities too so the server's stored memoryHash advances to match
        // the freshly-synced palace; otherwise the heartbeat drift-check would keep
        // nudging a memory refresh every beat.
        void pushCapabilitiesSnapshot(ws, config);
        return;
      }
      if (message.type === "agent_capabilities_refresh") {
        void pushCapabilitiesSnapshot(ws, config);
        return;
      }
      if (message.type === "error") {
        log(`Server rejected request: ${message.message || "unknown error"}`);
        return;
      }
      if (message.type === "agent_job" && message.job?.id) {
        const result = queue.enqueue({ ...message.job, key: message.job.id, lane: laneKeyForJob(message.job), ws });
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
      if (lastSocketErrorCode === "ECONNREFUSED" && isLocalBackendUrl(config.url)) {
        log("Local agent backend is not running on 127.0.0.1:3142.");
        log("Start it in another terminal with: npm run backend");
        log("Then rerun this connect command.");
        stop();
        return;
      }
      if (config.once && acceptedJobCount > 0 && queue.active() === 0 && queue.size() === 0) {
        stop();
      }
      if (stopped || config.once) return;
      reconnectTimer = setTimeout(connect, 2000);
      if (reconnectTimer.unref) reconnectTimer.unref();
    });

    ws.on("error", (error) => {
      lastSocketErrorCode = error?.code || '';
      log(`Socket error: ${error?.message || error}`);
    });
  };

  // Independent liveness file, written for the whole process lifetime — NOT gated on the
  // socket. This lets an external watchdog distinguish a dead daemon (stale `ts`) from a
  // healthy daemon that merely lost the server (fresh `ts`, `connected:false`). The WS
  // heartbeat above is the server's liveness signal; this file is everyone else's.
  const writeFileBeat = async () => {
    const agentStatus = await readAgentStatus(config).catch(() => null);
    await writeHeartbeatFile(config, {
      busy: queue.active() > 0,
      active: queue.active(),
      queueSize: queue.size(),
      connected: ws?.readyState === WebSocket.OPEN,
      agentStatus: agentStatus?.status,
      agentNote: agentStatus?.note,
    }).catch(() => {});
  };
  void writeFileBeat();
  fileHeartbeatTimer = setInterval(() => { void writeFileBeat(); }, config.heartbeatMs);
  if (fileHeartbeatTimer.unref) fileHeartbeatTimer.unref();

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
    url: String(raw.url || raw.baseUrl || process.env.AGENSIS_URL || "").trim(),
    token: String(raw.token || process.env.AGENSIS_TOKEN || "").trim(),
    workspace: String(raw.workspace || raw.workspaceId || process.env.AGENSIS_WORKSPACE || process.env.AGENSIS_WORKSPACE_ID || "").trim(),
    agent: String(raw.agent || raw.agentId || process.env.AGENSIS_AGENT || process.env.AGENSIS_AGENT_ID || "").trim(),
    handle: slugHandle(raw.handle || process.env.AGENSIS_HANDLE || raw.name || process.env.AGENSIS_NAME || "agent"),
    name: String(raw.name || process.env.AGENSIS_NAME || raw.handle || process.env.AGENSIS_HANDLE || "agensis Agent").trim(),
    cwd: String(raw.cwd || process.env.AGENSIS_CWD || process.cwd()).trim(),
    codingCmd: String(raw.codingCmd || process.env.AGENSIS_CODING_CMD || process.env.CODING_CMD || "claude -p").trim(),
    model: resolveModel(raw.model || process.env.AGENSIS_MODEL || process.env.CLAUDE_MODEL || ""),
    permissionMode: normalizePermissionMode(raw.permissionMode || raw.permission_mode || raw.permission || process.env.AGENSIS_PERMISSION_MODE || "default"),
    timeoutMs: Number(raw.timeoutMs || process.env.AGENSIS_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    heartbeatMs: Number(raw.heartbeatMs || process.env.AGENSIS_HEARTBEAT_MS || DEFAULT_HEARTBEAT_MS),
    maxConcurrency: Math.max(1, Number(raw.maxConcurrency || process.env.AGENSIS_MAX_CONCURRENCY || DEFAULT_MAX_CONCURRENCY) || DEFAULT_MAX_CONCURRENCY),
    once: Boolean(raw.once || process.env.AGENSIS_ONCE === "1"),
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

function socketUrl(baseUrl, token, config = {}) {
  const url = agentBackendUrl(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/backend/ws";
  url.search = "";
  url.searchParams.set("agentToken", token);
  if (config.workspace) url.searchParams.set("workspaceId", config.workspace);
  if (config.agent) url.searchParams.set("agentId", config.agent);
  return url.toString();
}

function agentBackendUrl(baseUrl) {
  const url = new URL(baseUrl);
  if ((url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0") && url.port === "8888") {
    // Netlify/Vite dev on :8888 serves HTTP functions only. The agent
    // websocket backend is the local API server on :3142.
    url.protocol = "http:";
    url.hostname = "127.0.0.1";
    url.port = "3142";
  }
  return url;
}

function isLocalBackendUrl(baseUrl) {
  try {
    const url = agentBackendUrl(baseUrl);
    return (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "0.0.0.0") && url.port === "3142";
  } catch {
    return false;
  }
}

// One lane per conversation. A DM and every channel are distinct chat sessions,
// and a thread within a channel is distinct again — matching the server's own
// per-conversation lock granularity (sessionId::threadParentId). Same lane → runs
// in order; different lanes → run in parallel.
function laneKeyForJob(job) {
  const session = String(job?.sessionId || "");
  const thread = String(job?.threadParentId || "");
  return `${session}::${thread}`;
}

async function runAgentJob(config, job, { signal }) {
  const started = Date.now();
  log(`Starting job ${job.id}`);
  const command = buildAgentCommand(config, job);
  const prompt = await buildPrompt(config, job);
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
  const parser = command.streamJson ? createStreamJsonParser() : null;
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
      if (parser) {
        parser.feed(chunk);
        fullContent = parser.live;
      } else {
        fullContent += String(chunk || "");
        latest = latestLine(`${latest}\n${chunk}`);
      }
      const now = Date.now();
      if (now - lastDeltaAt > 150) {
        lastDeltaAt = now;
        sendDelta(fullContent);
      }
    },
  });
  clearInterval(progressTimer);

  if (parser) {
    parser.end();
    fullContent = parser.live;
    sendDelta(fullContent); // flush the final tokens
  }

  const stdout = String(result.stdout || "").trim();
  const stderr = String(result.stderr || "").trim();
  const error = result.error
    ? result.error.message
    : result.status === 0
      ? ""
      : stderr || `Command exited with status ${result.status}`;
  const response = parser
    ? parser.result || (error ? "" : stderr)
    : stdout || (error ? "" : stderr) || latest || "";

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

async function buildPrompt(config, job) {
  const agent = job.agent || {};
  const skills = Array.isArray(agent.skills) ? agent.skills.join(", ") : String(agent.skills || "");
  const tools = Array.isArray(agent.tools) ? agent.tools.join(", ") : String(agent.tools || "");
  const model = resolveJobModel(config, job);
  const permissionMode = resolveJobPermissionMode(config, job);
  // Editable "what to do on each heartbeat" doc. Inlined so the agent sees its recurring
  // instructions without a tool call; the path is given so it can edit them.
  const heartbeatMd = await readHeartbeatMd(config).catch(() => null);
  const heartbeatSection = heartbeatMd
    ? `Heartbeat (recurring instructions — edit at ${heartbeatMdPath(config)}):\n${heartbeatMd}`
    : "";
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
    'Thread widgets: this chat has a right-side widget rail the human watches. When you work a multi-step task here, surface it: call create_thread_item (kind "todo", "plan", or "blocker") with the Channel session id above to post your plan steps and to-dos, mark them done with update_thread_item as you finish, and raise a "blocker" when you need the human to answer something (read their reply from the item response via list_thread_items). Keep it to a few real items, not every micro-step; skip it for quick one-off replies.',
    `Status file: you can report your own working status by overwriting the JSON file at ${statusFilePath(config)} with e.g. {"status":"working","note":"short summary of what you're doing"}. Your daemon reads it on its next heartbeat (~${Math.round((config.heartbeatMs || 15000) / 1000)}s) and surfaces it on your agent card. Optional and best-effort — overwrite the whole file, keep note under ~200 chars, and there's no need to clear it.`,
    heartbeatSection,
    "Respond with a clear channel-ready result. Use markdown for structure — bullets, headers, and code blocks where appropriate. If you changed files, summarize the files and verification. If you cannot complete it, say exactly why.",
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

    // Stream tokens as they arrive instead of one buffered dump at exit.
    // Plain `claude -p` defaults to --output-format text, which buffers the
    // whole reply and writes it once on close — so the chat sits on "Thinking…"
    // then pops the full answer. stream-json + partial messages emit NDJSON
    // deltas we parse incrementally (see createStreamJsonParser).
    // Only auto-enable when the user hasn't pinned their own --output-format,
    // and only in print mode (the flags require --print / -p).
    const hasOutputFormat = cleanArgs.some(
      (a) => a === "--output-format" || String(a).startsWith("--output-format="),
    );
    const hasPrint = cleanArgs.includes("-p") || cleanArgs.includes("--print");
    let streamJson = false;
    if (!hasOutputFormat && hasPrint) {
      nextArgs.push("--output-format", "stream-json", "--include-partial-messages");
      if (!cleanArgs.includes("--verbose")) nextArgs.push("--verbose");
      streamJson = true;
    } else if (hasOutputFormat) {
      streamJson = cleanArgs.some((a) => /stream-json/.test(String(a)));
    }
    return { cmd, args: nextArgs, model, permissionMode, permissionFlags, streamJson };
  }

  if (isCodexCommand(cmd)) {
    const nextArgs = [...cleanArgs];
    if (model) nextArgs.push("--model", model);
    if (permissionMode === "yolo") nextArgs.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
    return { cmd, args: nextArgs, model, permissionMode, permissionFlags };
  }

  return { cmd, args, model, permissionMode, permissionFlags };
}

// Incrementally parses Claude's `--output-format stream-json` NDJSON stream.
// Each line is a JSON event. We accumulate token-level text_delta events for a
// live, streaming view and pull the authoritative final answer from the
// `result` event. Robust to both the partial-message wrapping (event.delta)
// and bare delta shapes, and falls back to complete `assistant` messages when
// partial messages aren't present.
function createStreamJsonParser() {
  let buffer = "";
  let streamed = ""; // accumulated text_delta tokens (live view)
  let sawDelta = false;
  let assistantText = ""; // fallback when no token-level deltas arrive
  let finalResult = null; // authoritative text from the `result` event

  const handleEvent = (evt) => {
    if (!evt || typeof evt !== "object") return;
    const delta = (evt.event && evt.event.delta) || evt.delta;
    if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
      sawDelta = true;
      streamed += delta.text;
      return;
    }
    if (evt.type === "result" && typeof evt.result === "string") {
      finalResult = evt.result;
      return;
    }
    if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      const text = evt.message.content
        .filter((b) => b && b.type === "text" && typeof b.text === "string")
        .map((b) => b.text)
        .join("");
      if (text) assistantText += text;
    }
  };

  const parseLine = (line) => {
    const trimmed = String(line).trim();
    if (!trimmed) return;
    try {
      handleEvent(JSON.parse(trimmed));
    } catch {
      /* ignore non-JSON noise on the stream */
    }
  };

  return {
    feed(chunk) {
      buffer += String(chunk || "");
      let idx;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        parseLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    end() {
      if (buffer) {
        parseLine(buffer);
        buffer = "";
      }
    },
    get live() {
      return sawDelta ? streamed : assistantText;
    },
    get result() {
      if (finalResult != null) return finalResult;
      return sawDelta ? streamed : assistantText;
    },
  };
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

// Build the heartbeat metadata sent to the server, folding in the agent's self-declared
// status (from status.json) when present. The server merges this object into the stored
// connection row, so agentStatus/agentNote surface on the agent card for free.
function heartbeatMetadata(config, queue, agentStatus) {
  const metadata = {
    busy: queue.active() > 0,
    queueSize: queue.size(),
    cwd: config.cwd,
    model: config.model,
    permissionMode: config.permissionMode,
    permissionFlags: permissionFlagsForMode(config.permissionMode),
  };
  if (agentStatus?.status) metadata.agentStatus = agentStatus.status;
  if (agentStatus?.note) metadata.agentNote = agentStatus.note;
  if (agentStatus?.status || agentStatus?.note) metadata.agentStatusAt = new Date().toISOString();
  return metadata;
}

function applyAgentConfig(config, agent) {
  if (!agent || typeof agent !== "object") return;
  if (agent.name) config.name = String(agent.name).trim() || config.name;
  if (agent.handle || agent.name) config.handle = slugHandle(agent.handle || agent.name || config.handle);
  if (agent.model) config.model = resolveModel(agent.model);
  const permissionMode = agent.permissionMode || agent.permission_mode;
  if (permissionMode) config.permissionMode = normalizePermissionMode(permissionMode);
  if (agent.memory_dir !== undefined || agent.memoryDir !== undefined) {
    config.memoryDir = String(agent.memory_dir ?? agent.memoryDir ?? "").trim();
  }
}

// Detect installed skills from well-known skill directories.
function detectSkills(cwd) {
  const dirs = [
    path.join(os.homedir(), ".claude", "skills"),
    path.join(os.homedir(), ".codex", "skills"),
    path.join(cwd || process.cwd(), ".claude", "skills"),
  ];
  const names = new Set();
  for (const dir of dirs) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith(".md")) names.add(entry.slice(0, -3));
      }
    } catch {
      // directory doesn't exist — skip
    }
  }
  return [...names].sort();
}

// Check which well-known CLIs are on PATH.
function detectClis() {
  const targets = ["claude", "codex", "gh", "node", "npm", "python3", "git", "fly", "vercel"];
  const pathDirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return targets.filter(cli =>
    pathDirs.some(dir => {
      try { return fs.existsSync(path.join(dir, cli)); } catch { return false; }
    })
  );
}

// Read MCP server names from ~/.claude.json if present.
function detectMcpServers() {
  try {
    const raw = fs.readFileSync(path.join(os.homedir(), ".claude.json"), "utf8");
    const parsed = JSON.parse(raw);
    const servers = parsed?.mcpServers;
    if (servers && typeof servers === "object") return Object.keys(servers).sort();
  } catch {
    // file missing or malformed — not fatal
  }
  return [];
}

function sha1Short(str) {
  return crypto.createHash("sha1").update(String(str)).digest("hex").slice(0, 16);
}

// Detect this agent's current runtime capabilities and compute the two daemon-owned
// drift hashes. The daemon is the single authority for these hashes: it emits them on
// both the full snapshot (agent_capabilities_sync) and every heartbeat, so the server
// never has to recompute a canonical form — it just compares the heartbeat hash against
// the last value it stored on a snapshot. `capabilitiesHash` covers skills/CLIs/MCP;
// `memoryHash` covers the palace file list (stat-only, no content reads).
async function computeCapabilities(config) {
  const skills = detectSkills(config.cwd);
  const clis = detectClis();
  const mcpServers = detectMcpServers();
  const memoryRoot = deriveMemoryRoot({ cwd: config.cwd, memoryDir: config.memoryDir }) || null;
  // Arrays are already sorted at detection, so this canonical form is stable.
  const capabilitiesHash = sha1Short(JSON.stringify({ skills, clis, mcpServers, memoryRoot }));
  const memoryHash = sha1Short(await memoryFingerprint(memoryRoot));
  return { skills, clis, mcpServers, memoryRoot, capabilitiesHash, memoryHash };
}

// Push a snapshot of this agent's runtime capabilities (skills, CLIs, MCP servers,
// memory root) to the server, carrying the daemon-owned hashes so the server can store
// them as the reference the heartbeat drift-check compares against. Fire-and-forget.
async function pushCapabilitiesSnapshot(ws, config) {
  try {
    const caps = await computeCapabilities(config);
    send(ws, {
      action: "agent_capabilities_sync",
      workspaceId: config.workspace,
      agentId: config.agent,
      skills: caps.skills,
      clis: caps.clis,
      mcpServers: caps.mcpServers,
      memoryRoot: caps.memoryRoot,
      hash: caps.capabilitiesHash,
      memoryHash: caps.memoryHash,
    });
    log(`Capabilities synced — skills:${caps.skills.length} clis:${caps.clis.length} mcp:${caps.mcpServers.length}`);
  } catch (error) {
    log(`Capabilities sync skipped: ${error?.message || error}`);
  }
}

// Push a read-only snapshot of this agent's file-memory palace to the server so the
// app can mirror it. Fire-and-forget: failures (no palace, fs errors) are logged, not
// fatal. The root is the explicit memory_dir or the derived Claude palace for cwd.
async function pushMemorySnapshot(ws, config) {
  try {
    const root = deriveMemoryRoot({ cwd: config.cwd, memoryDir: config.memoryDir });
    if (!root) return;
    const files = await snapshotMemory(root);
    send(ws, {
      action: "agent_memory_sync",
      workspaceId: config.workspace,
      agentId: config.agent,
      root,
      files,
    });
    log(`Synced ${files.length} memory file${files.length === 1 ? "" : "s"} from ${root}`);
  } catch (error) {
    log(`Memory sync skipped: ${error?.message || error}`);
  }
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
