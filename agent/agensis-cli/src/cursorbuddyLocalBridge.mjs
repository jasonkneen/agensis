import http from "node:http";
import os from "node:os";
import process from "node:process";
import { runCli } from "./cli.mjs";

const DEFAULT_PORT = 8787;
const CONTROL_QUEUE_LIMIT = 100;
const CONTROL_ACTIONS = new Set(["say", "wave", "hush", "open", "choose"]);
const FAST_CHAT_PATTERNS = [
  {
    re: /^(hi|hello|hey|yo|sup)\b/i,
    text: "Hi. I am connected to your local Agensis runtime.",
  },
  {
    re: /\b(are you connected|connected|working|online|there)\b/i,
    text: "Yes. The local Agensis runtime is connected and I can receive page context.",
  },
  {
    re: /\b(tell me )?(a )?joke\b/i,
    text: "Why did the cursor refuse to get lost? It always had a pointer.",
  },
];

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.end(JSON.stringify(body));
}

function sseStart(res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store, no-transform",
    connection: "keep-alive",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    "x-accel-buffering": "no",
  });
}

function sseSend(res, data) {
  res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 256 * 1024) {
        reject(new Error("request body is too large"));
        req.destroy();
      }
    });
    req.on("error", reject);
    req.on("end", () => resolve(body));
  });
}

function splitCommand(command) {
  const parts = [];
  let current = "";
  let quote = "";
  let escape = false;
  for (const ch of String(command || "")) {
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

function isClaudeCommand(cmd) {
  return /(^|\/)claude(?:$|\.)/.test(String(cmd || ""));
}

function hasFlag(args, flag) {
  return args.some((arg) => arg === flag || String(arg).startsWith(`${flag}=`));
}

function messagesToPrompt(messages, context) {
  const lines = [];
  if (context) {
    lines.push(
      "CursorBuddy local runtime context:",
      JSON.stringify(context, null, 2),
      "",
    );
  }
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = String(message?.role || "user");
    const content = String(message?.content || "");
    if (!content.trim()) continue;
    lines.push(`${role.toUpperCase()}:\n${content}`);
  }
  return lines.join("\n\n").trim() || "Say that the local Agensis runtime is connected.";
}

function parseCliText(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.result === "string") return parsed.result;
    if (typeof parsed?.message === "string") return parsed.message;
    if (typeof parsed?.content === "string") return parsed.content;
  } catch {
    // plain text output
  }
  return text;
}

function lastUserMessage(payload) {
  const messages = Array.isArray(payload?.messages) ? payload.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (String(message?.role || "user") !== "user") continue;
    const content = String(message?.content || "").trim();
    if (content) return content;
  }
  return "";
}

function fastLocalReply(payload, context) {
  const text = lastUserMessage(payload);
  if (!text || text.length > 120) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  for (const pattern of FAST_CHAT_PATTERNS) {
    if (pattern.re.test(normalized)) return pattern.text;
  }
  if (/^(what site|where am i|what page)\b/i.test(normalized) && context?.url) {
    const title = context.title ? `${context.title} at ` : "";
    return `You are on ${title}${context.url}.`;
  }
  return "";
}

function modelLooksLikeCommand(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  if (/\s/.test(text)) return true;
  if (text.startsWith("-")) return true;
  return /^(claude|codex|node|npm|bun|python|python3|sh|bash|zsh)(?:$|\.)/.test(text);
}

function requestedModelForLocalBridge(requestedModel, fallbackModel) {
  const model = String(requestedModel || "").trim();
  if (!model || modelLooksLikeCommand(model)) return fallbackModel;
  return model;
}

function buildLocalCommand(config, prompt, requestedModel, options = {}) {
  const { cmd, args } = splitCommand(config.codingCmd || "claude -p");
  const nextArgs = [...args];
  const model = requestedModelForLocalBridge(requestedModel, config.model);
  let stdin = "";
  let streamJson = false;
  if (isClaudeCommand(cmd)) {
    if (model && !hasFlag(nextArgs, "--model")) nextArgs.push("--model", model);
    const wantsStream = options.stream === true;
    if (wantsStream && !hasFlag(nextArgs, "--output-format")) {
      nextArgs.push("--output-format", "stream-json", "--include-partial-messages");
      if (!hasFlag(nextArgs, "--verbose")) nextArgs.push("--verbose");
      streamJson = true;
    } else {
      if (!hasFlag(nextArgs, "--output-format")) nextArgs.push("--output-format", "json");
      streamJson = nextArgs.some((arg) => String(arg).includes("stream-json"));
    }
    stdin = prompt;
  } else {
    nextArgs.push(prompt);
  }
  return { cmd, args: nextArgs, model, stdin, streamJson };
}

function createStreamJsonParser(onDelta = () => {}) {
  let buffer = "";
  let streamed = "";
  let sawDelta = false;
  let assistantText = "";
  let finalResult = null;

  const emit = (text) => {
    if (!text) return;
    onDelta(text);
  };

  const handleEvent = (evt) => {
    if (!evt || typeof evt !== "object") return;
    const delta = (evt.event && evt.event.delta) || evt.delta;
    if (delta && delta.type === "text_delta" && typeof delta.text === "string") {
      sawDelta = true;
      streamed += delta.text;
      emit(delta.text);
      return;
    }
    if (evt.type === "result" && typeof evt.result === "string") {
      finalResult = evt.result;
      return;
    }
    if (evt.type === "assistant" && evt.message && Array.isArray(evt.message.content)) {
      const text = evt.message.content
        .filter((block) => block && block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
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
      /* ignore non-JSON CLI noise */
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

function completionChunk(id, model, content, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: content ? { content } : {},
        finish_reason: finishReason,
      },
    ],
  };
}

function endpointOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

export async function startCursorBuddyLocalBridge(config, options = {}) {
  const port = Number(options.port ?? config.cursorBuddyPort ?? process.env.AGENSIS_CURSORBUDDY_PORT ?? DEFAULT_PORT);
  const bootedAt = new Date().toISOString();
  const events = [];
  const controlQueue = [];
  const controlClients = new Set();
  let nextControlId = 1;
  let activeContext = null;
  let actualPort = port;

  const record = (event, detail = {}) => {
    const entry = { ts: new Date().toISOString(), event, detail };
    events.push(entry);
    if (events.length > 200) events.shift();
    options.log?.(`CursorBuddy local bridge: ${event}${Object.keys(detail).length ? ` ${JSON.stringify(detail)}` : ""}`);
    return entry;
  };

  const connection = () => ({
    connected: true,
    mode: "agensis-cli",
    agentId: config.agent,
    workspaceId: config.workspace,
    agensisUrl: config.url,
    handle: config.handle,
    name: config.name,
    cwd: config.cwd,
    updatedAt: new Date().toISOString(),
  });

  function sanitizeControlCommand(payload = {}) {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
    const action = String(payload.action || payload.type || "").trim().toLowerCase();
    if (!CONTROL_ACTIONS.has(action)) return null;
    const command = {
      id: nextControlId++,
      ts: new Date().toISOString(),
      action,
      text: String(payload.text || payload.say || payload.message || "").slice(0, 1200),
      label: String(payload.label || "").slice(0, 80),
      value: String(payload.value || payload.prompt || "").slice(0, 1200),
      holdMs: Number.isFinite(payload.holdMs) ? Math.max(0, Math.min(60000, payload.holdMs)) : undefined,
      source: String(payload.source || "agensis-daemon").slice(0, 80),
    };
    if (payload.options && Array.isArray(payload.options)) {
      command.options = payload.options
        .map((option) => ({
          label: String(option?.label || "").slice(0, 80),
          value: String(option?.value || option?.task || "").slice(0, 1200),
        }))
        .filter((option) => option.label)
        .slice(0, 6);
    }
    return command;
  }

  function enqueueControlCommand(command) {
    controlQueue.push(command);
    while (controlQueue.length > CONTROL_QUEUE_LIMIT) controlQueue.shift();
    record("control", { id: command.id, action: command.action, chars: command.text.length });
    for (const client of [...controlClients]) {
      try {
        sseSend(client, { type: "command", command });
      } catch {
        controlClients.delete(client);
      }
    }
    return command;
  }

  async function complete(payload) {
    const fast = fastLocalReply(payload, activeContext);
    if (fast) return { content: fast, model: "cursorbuddy-local-fast", fast: true };
    const prompt = messagesToPrompt(payload?.messages, activeContext);
    const command = buildLocalCommand(config, prompt, payload?.model);
    const result = await runCli({
      cmd: command.cmd,
      args: command.args,
      cwd: config.cwd,
      timeoutMs: Math.min(Number(config.timeoutMs || 1800000), 5 * 60 * 1000),
      heartbeatMs: config.heartbeatMs,
      label: "cursorbuddy local chat",
      input: command.stdin,
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || String(result.stderr || "").trim() || `Command exited with status ${result.status}`);
    }
    return { content: parseCliText(result.stdout || result.stderr), model: command.model };
  }

  async function streamComplete(payload, res) {
    const id = `agensis-cursorbuddy-${Date.now()}`;
    const fast = fastLocalReply(payload, activeContext);
    if (fast) {
      const model = "cursorbuddy-local-fast";
      sseSend(res, completionChunk(id, model, fast));
      sseSend(res, completionChunk(id, model, "", "stop"));
      sseSend(res, "[DONE]");
      record("chat_fast", { chars: fast.length });
      return { content: fast, model, fast: true };
    }

    const prompt = messagesToPrompt(payload?.messages, activeContext);
    const command = buildLocalCommand(config, prompt, payload?.model, { stream: true });
    let content = "";
    const sendText = (text) => {
      if (!text) return;
      content += text;
      sseSend(res, completionChunk(id, command.model || config.model, text));
    };
    const parser = command.streamJson ? createStreamJsonParser(sendText) : null;
    const result = await runCli({
      cmd: command.cmd,
      args: command.args,
      cwd: config.cwd,
      timeoutMs: Math.min(Number(config.timeoutMs || 1800000), 5 * 60 * 1000),
      heartbeatMs: config.heartbeatMs,
      label: "cursorbuddy local chat",
      input: command.stdin,
      onData: (chunk) => {
        if (parser) {
          parser.feed(chunk);
        } else {
          const text = String(chunk || "");
          content += text;
          sseSend(res, completionChunk(id, command.model || config.model, text));
        }
      },
    });
    if (parser) {
      parser.end();
      const final = parser.result || "";
      if (!content && final) sendText(final);
      else content = final || content;
    }
    if (result.error || result.status !== 0) {
      const message = result.error?.message || String(result.stderr || "").trim() || `Command exited with status ${result.status}`;
      throw new Error(message);
    }
    const parsed = parser ? content : parseCliText(content || result.stdout || result.stderr);
    if (!parser && parsed && parsed !== content) {
      sseSend(res, completionChunk(id, command.model || config.model, parsed));
      content = parsed;
    }
    sseSend(res, completionChunk(id, command.model || config.model, "", "stop"));
    sseSend(res, "[DONE]");
    return { content: content || parsed, model: command.model };
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, authorization");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url || "/", endpointOrigin(actualPort || DEFAULT_PORT));

    if (req.method === "GET" && url.pathname === "/cursorbuddy/health") {
      const origin = endpointOrigin(actualPort);
      json(res, 200, {
        ok: true,
        runtime: "agensis-cli",
        backend: config.codingCmd,
        model: config.model,
        port: actualPort,
        host: os.hostname(),
        pid: process.pid,
        bootedAt,
        connection: connection(),
        context: activeContext,
        endpoints: {
          chat: `${origin}/v1/chat/completions`,
          edit: `${origin}/cursorbuddy/edit`,
          context: `${origin}/cursorbuddy/context`,
          control: `${origin}/cursorbuddy/control`,
          controlStream: `${origin}/cursorbuddy/control/stream`,
          logs: `${origin}/cursorbuddy/logs`,
        },
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/cursorbuddy/logs") {
      json(res, 200, { ok: true, events: events.slice(-100) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/cursorbuddy/context") {
      json(res, 200, { ok: true, context: activeContext });
      return;
    }

    if (req.method === "GET" && url.pathname === "/cursorbuddy/control") {
      const after = Number(url.searchParams.get("after") || 0);
      const commands = controlQueue.filter((command) => command.id > after);
      json(res, 200, { ok: true, commands, latestId: controlQueue.at(-1)?.id || 0 });
      return;
    }

    if (req.method === "GET" && url.pathname === "/cursorbuddy/control/stream") {
      const after = Number(url.searchParams.get("after") || 0);
      sseStart(res);
      controlClients.add(res);
      sseSend(res, { type: "ready", latestId: controlQueue.at(-1)?.id || 0 });
      for (const command of controlQueue.filter((item) => item.id > after)) {
        sseSend(res, { type: "command", command });
      }
      const ping = setInterval(() => {
        try {
          sseSend(res, { type: "ping", ts: new Date().toISOString() });
        } catch {
          controlClients.delete(res);
          clearInterval(ping);
        }
      }, 15000);
      if (ping.unref) ping.unref();
      req.on("close", () => {
        controlClients.delete(res);
        clearInterval(ping);
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/cursorbuddy/control") {
      try {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const command = sanitizeControlCommand(payload);
        if (!command) {
          json(res, 400, { ok: false, error: "unsupported CursorBuddy control command" });
          return;
        }
        const queued = enqueueControlCommand(command);
        json(res, 200, { ok: true, command: queued });
      } catch (error) {
        record("control_error", { error: String(error?.message || error) });
        json(res, 400, { ok: false, error: String(error?.message || error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/cursorbuddy/context") {
      try {
        const payload = JSON.parse((await readBody(req)) || "{}");
        activeContext = {
          url: String(payload.url || "").slice(0, 2048),
          title: String(payload.title || "").slice(0, 300),
          surface: String(payload.surface || "").slice(0, 80),
          workspaceId: String(payload.workspaceId || config.workspace || "").slice(0, 120),
          agentId: String(payload.agentId || config.agent || "").slice(0, 120),
          project: payload.project && typeof payload.project === "object" ? payload.project : null,
          manifest: payload.manifest && typeof payload.manifest === "object" ? payload.manifest : null,
          selection: payload.selection && typeof payload.selection === "object" ? payload.selection : null,
          updatedAt: new Date().toISOString(),
        };
        record("context", { url: activeContext.url, surface: activeContext.surface });
        json(res, 200, { ok: true, context: activeContext });
      } catch (error) {
        record("context_error", { error: String(error?.message || error) });
        json(res, 400, { ok: false, error: String(error?.message || error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/cursorbuddy/edit") {
      try {
        const payload = JSON.parse((await readBody(req)) || "{}");
        const messages = [
          {
            role: "system",
            content: "You are the local CursorBuddy edit agent. The user selected a DOM element in their own site. Use the payload to inspect and change the local checkout, then report what changed.",
          },
          { role: "user", content: JSON.stringify(payload, null, 2) },
        ];
        record("edit_request", { selector: payload?.target?.selector || "" });
        const result = await complete({ messages, model: payload?.model });
        record("edit_done", { chars: result.content.length });
        json(res, 200, { ok: true, backend: config.codingCmd, cwd: config.cwd, content: result.content });
      } catch (error) {
        record("edit_error", { error: String(error?.message || error) });
        json(res, 500, { ok: false, error: String(error?.message || error) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname.endsWith("/chat/completions")) {
      try {
        const payload = JSON.parse((await readBody(req)) || "{}");
        record("chat_request", { messages: Array.isArray(payload.messages) ? payload.messages.length : 0, model: payload.model || config.model });
        if (payload.stream === true) {
          sseStart(res);
          const result = await streamComplete(payload, res);
          record("chat_done", { chars: result.content.length, stream: true, fast: result.fast === true });
          res.end();
          return;
        }
        const result = await complete(payload);
        record("chat_done", { chars: result.content.length, fast: result.fast === true });
        json(res, 200, {
          id: `agensis-cursorbuddy-${Date.now()}`,
          object: "chat.completion",
          model: result.model || payload.model || config.model,
          choices: [{ index: 0, message: { role: "assistant", content: result.content }, finish_reason: "stop" }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        });
      } catch (error) {
        record("chat_error", { error: String(error?.message || error) });
        json(res, 500, { error: { message: String(error?.message || error) } });
      }
      return;
    }

    res.writeHead(404);
    res.end("CursorBuddy local bridge");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      actualPort = server.address().port;
      server.off("error", reject);
      resolve();
    });
  });

  record("listening", { url: `${endpointOrigin(actualPort)}/cursorbuddy/health` });
  return {
    port: actualPort,
    url: endpointOrigin(actualPort),
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
