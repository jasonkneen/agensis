import http from "node:http";
import os from "node:os";
import process from "node:process";
import { runCli } from "./cli.mjs";

const DEFAULT_PORT = 8787;

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  });
  res.end(JSON.stringify(body));
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

function buildLocalCommand(config, prompt, requestedModel) {
  const { cmd, args } = splitCommand(config.codingCmd || "claude -p");
  const nextArgs = [...args];
  const model = requestedModel || config.model;
  if (isClaudeCommand(cmd)) {
    if (model && !hasFlag(nextArgs, "--model")) nextArgs.push("--model", model);
    if (!hasFlag(nextArgs, "--output-format")) nextArgs.push("--output-format", "json");
  }
  nextArgs.push(prompt);
  return { cmd, args: nextArgs, model };
}

function endpointOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

export async function startCursorBuddyLocalBridge(config, options = {}) {
  const port = Number(options.port ?? config.cursorBuddyPort ?? process.env.AGENSIS_CURSORBUDDY_PORT ?? DEFAULT_PORT);
  const bootedAt = new Date().toISOString();
  const events = [];
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

  async function complete(payload) {
    const prompt = messagesToPrompt(payload?.messages, activeContext);
    const command = buildLocalCommand(config, prompt, payload?.model);
    const result = await runCli({
      cmd: command.cmd,
      args: command.args,
      cwd: config.cwd,
      timeoutMs: Math.min(Number(config.timeoutMs || 1800000), 5 * 60 * 1000),
      heartbeatMs: config.heartbeatMs,
      label: "cursorbuddy local chat",
    });
    if (result.error || result.status !== 0) {
      throw new Error(result.error?.message || String(result.stderr || "").trim() || `Command exited with status ${result.status}`);
    }
    return { content: parseCliText(result.stdout || result.stderr), model: command.model };
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
        const result = await complete(payload);
        record("chat_done", { chars: result.content.length });
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
