#!/usr/bin/env node
import os from "node:os";
import process from "node:process";
import { AGENSIS_CLI_VERSION, runAgensisDaemon } from "../src/agensis.mjs";

function parseArgs(argv) {
  const args = { command: "connect" };
  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith("-")) {
    args.command = rest.shift();
    if (args.command === "buddy") {
      const subcommand = rest[0];
      if (subcommand && !subcommand.startsWith("-")) args.subcommand = rest.shift();
      else args.subcommand = "connect";
    }
  }

  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected argument: ${arg}`);
    }
    const [rawKey, inlineValue] = arg.slice(2).split(/=(.*)/s, 2);
    const key = rawKey.replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
    if (key === "help") {
      args.help = true;
      continue;
    }
    if (key === "version") {
      args.version = true;
      continue;
    }
    if (key === "once") {
      args.once = true;
      continue;
    }
    if (key === "lan") {
      args.lanListener = true;
      continue;
    }
    if (key === "yolo" || key === "noSandbox") {
      args.permissionMode = "yolo";
      continue;
    }
    if (key === "acceptEdits") {
      args.permissionMode = "accept_edits";
      continue;
    }
    const value = inlineValue !== undefined ? inlineValue : rest[++i];
    if (value == null || value.startsWith("--")) {
      throw new Error(`Missing value for --${rawKey}`);
    }
    args[key] = value;
  }
  return args;
}

function usage() {
  return `agensis agent daemon

Usage:
  agensis --url <workspace-url> --token <token> --workspace <id> --agent <id> [options]
  agensis connect --url <workspace-url> --token <token> --workspace <id> --agent <id> [options]
  agensis buddy connect --key <cbk_...> [--url <agensis-url>] [options]

Required:
  --url <url>             agensis app/backend URL, for example https://agensis.io or http://localhost:5173
  --token <token>         Agent connection token from agensis
  --workspace <id>        Workspace id
  --agent <id>            Workspace agent id
  --key <cbk_...>         One-time CursorBuddy connection key for buddy connect

Options:
  --handle <name>         Mention handle used in channels
  --name <name>           Display name
  --cwd <path>            Folder where the coding CLI runs
  --coding-cmd <command>  Command used for jobs, default: claude -p
  --model <id>            Default model to pass to supported coding CLIs
  --permission-mode <m>   default, accept_edits, or yolo
  --yolo                  Alias for --permission-mode yolo
  --no-sandbox            Alias for --permission-mode yolo
  --timeout-ms <ms>       Kill a job after this time, default: 1800000
  --heartbeat-ms <ms>     Local terminal heartbeat interval, default: 15000
  --once                  Run one queued job then exit
  --lan                   Opt in to the agent-mesh LAN listener for direct
                          daemon-to-daemon job handoff (default: off)
  --version               Print the CLI version
  --help                  Show this help
`;
}

function backendBaseUrl(args) {
  return String(args.url || args.baseUrl || process.env.AGENSIS_URL || "https://agensis.io").trim().replace(/\/+$/, "");
}

async function claimCursorBuddyConnectionKey(args) {
  const key = String(args.key || "").trim();
  if (!/^cbk_[a-z0-9_]+_[A-Z2-9]{18}$/.test(key)) {
    throw new Error("Missing or invalid --key. Create a CursorBuddy connection key in Agensis first.");
  }
  const baseUrl = backendBaseUrl(args);
  const response = await fetch(`${baseUrl}/backend/cursorbuddy/connection-keys/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      key,
      baseUrl,
      host: os.hostname(),
      cwd: args.cwd || process.cwd(),
      name: args.name,
      surface: args.surface || "local_cli",
      scope: args.scope || "machine",
      runtimeKind: "agensis-cli",
      version: AGENSIS_CLI_VERSION,
      permissionMode: args.permissionMode,
      model: args.model,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `CursorBuddy key claim failed with HTTP ${response.status}`);
  }
  const data = body?.data || body;
  const token = data?.token;
  const workspace = data?.workspaceId || data?.workspace_id || data?.agent?.workspace_id;
  const agent = data?.agentId || data?.agent?.id;
  if (!token || !workspace || !agent) {
    throw new Error("CursorBuddy key claim did not return a complete daemon connection payload");
  }
  return {
    ...args,
    command: "connect",
    url: data.baseUrl || baseUrl,
    token,
    workspace,
    agent,
    handle: data.handle || args.handle,
    name: data.agent?.name || args.name || "CursorBuddy runtime",
    model: data.model || args.model,
    permissionMode: data.permissionMode || data.permission_mode || args.permissionMode,
    cwd: args.cwd || process.cwd(),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.version) {
    process.stdout.write(`${AGENSIS_CLI_VERSION}\n`);
    return;
  }
  if (args.command === "buddy") {
    if (args.subcommand !== "connect") {
      throw new Error(`Unknown buddy command "${args.subcommand || ""}". Use "agensis buddy connect --key <cbk_...>".`);
    }
    const daemonArgs = await claimCursorBuddyConnectionKey(args);
    daemonArgs.exitOnOnce = true;
    await runAgensisDaemon(daemonArgs);
    if (daemonArgs.once) process.exit(0);
    return;
  }
  if (args.command !== "connect") {
    throw new Error(`Unknown command "${args.command}". Use "agensis --url ...", "agensis connect --url ...", or "agensis buddy connect --key ...".`);
  }
  args.exitOnOnce = true;
  await runAgensisDaemon(args);
  if (args.once) {
    process.exit(0);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
