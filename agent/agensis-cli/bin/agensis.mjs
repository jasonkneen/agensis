#!/usr/bin/env node
import process from "node:process";
import { AGENSIS_CLI_VERSION, runAgensisDaemon } from "../src/agensis.mjs";
import {
  daemonProfileName,
  daemonProfileSetupMessage,
  hasCompleteDaemonConnection,
  hasDaemonConnectionMaterial,
  mergeDaemonProfile,
  readDaemonProfile,
  writeDaemonProfile,
} from "../src/connectProfiles.mjs";
import { claimCursorBuddyConnectionKey } from "../src/cursorbuddyConnect.mjs";
import { runSetupFlow } from "../src/setupFlow.mjs";

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
    if (key === "noCursorbuddyBridge") {
      args.cursorBuddyBridge = false;
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
  agensis connect [--profile <name>]
  agensis setup [--url <agensis-url>] [--profile <name>] [--handle <name>]
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
  --cursorbuddy-port <n>  Local CursorBuddy discovery/chat port, default: 8787
  --no-cursorbuddy-bridge Disable local CursorBuddy discovery/chat bridge
  --once                  Run one queued job then exit
  --lan                   Opt in to the agent-mesh LAN listener for direct
                          daemon-to-daemon job handoff (default: off)
  --profile <name>        Save/reuse a local daemon profile, default: default
  --version               Print the CLI version
  --help                  Show this help
`;
}

async function daemonArgsForConnect(args) {
  const profile = daemonProfileName(args.profile || "default");
  if (!hasDaemonConnectionMaterial(args)) {
    const cached = await readDaemonProfile(profile);
    if (!cached) throw new Error(daemonProfileSetupMessage(profile));
    return mergeDaemonProfile(cached, args);
  }

  if (!hasCompleteDaemonConnection(args)) {
    return args;
  }

  return {
    ...args,
    onRegistered: async (config) => {
      await writeDaemonProfile(profile, config);
      process.stdout.write(`[agensis] Saved daemon profile "${profile}". Restart with: agensis connect${profile === "default" ? "" : ` --profile ${profile}`}\n`);
    },
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
  if (args.command === "setup") {
    const daemonArgs = await runSetupFlow(args);
    daemonArgs.exitOnOnce = true;
    await runAgensisDaemon({ ...args, ...daemonArgs });
    if (daemonArgs.once) process.exit(0);
    return;
  }
  if (args.command !== "connect") {
    throw new Error(`Unknown command "${args.command}". Use "agensis setup", "agensis connect --url ...", or "agensis buddy connect --key ...".`);
  }
  const daemonArgs = await daemonArgsForConnect(args);
  daemonArgs.exitOnOnce = true;
  await runAgensisDaemon(daemonArgs);
  if (daemonArgs.once) {
    process.exit(0);
  }
}

main().catch((error) => {
  process.stderr.write(`${error?.message || error}\n`);
  process.exitCode = 1;
});
