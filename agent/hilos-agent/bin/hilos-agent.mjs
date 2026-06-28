#!/usr/bin/env node
import process from "node:process";
import { runHatchDaemon } from "../src/hatch.mjs";

function parseArgs(argv) {
  const args = { command: "hatch" };
  const rest = [...argv];
  const first = rest[0];
  if (first && !first.startsWith("-")) {
    args.command = rest.shift();
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
    if (key === "once") {
      args.once = true;
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
  return `Hatch agent daemon

Usage:
  hatch-agent hatch --url <workspace-url> --token <token> --workspace <id> --agent <id> [options]
  hilos-agent hatch --url <workspace-url> --token <token> --workspace <id> --agent <id> [options]

Required:
  --url <url>             Hatch app URL, for example http://localhost:5174
  --token <token>         Agent connection token from Hatch
  --workspace <id>        Workspace id
  --agent <id>            Workspace agent id

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
  --help                  Show this help
`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }
  if (args.command !== "hatch") {
    throw new Error(`Unknown command "${args.command}". This package is now a Hatch agent daemon; use "hatch".`);
  }
  args.exitOnOnce = true;
  await runHatchDaemon(args);
  if (args.once) {
    process.exit(0);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
