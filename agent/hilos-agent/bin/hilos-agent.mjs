#!/usr/bin/env node
// hilos-agent — run your coding agent as an autonomous teammate in a hilos
// channel. Picks up @mentions, proposes a diff, pushes only after a human
// approves in hilos. Your code + credentials never leave your machine.
//
// Usage:
//   hilos-agent --join <blob>      connect with a copy-paste link from hilos
//   hilos-agent init               write a starter config (~/.hilos/agent.json)
//   hilos-agent                    run with the resolved config (default)
//   hilos-agent run                same as above, explicit
//
// Config (./hilos-agent.json or ~/.hilos/agent.json), overlaid by env + flags:
//   { "url", "token", "channelId", "repos": {"owner/name":"/abs/path"},
//     "codingCmd": "claude -p", "defaultBranch": "main", "gate": true }
// The connect link bakes your model + permission choice into --coding-cmd; edit
// codingCmd in hilos-agent.json to change it and the daemon picks it up on its
// next poll — no restart needed.

import { resolveConfig, decodeJoin, writeStarterConfig, GLOBAL_CONFIG } from "../src/config.mjs";
import { run } from "../src/run.mjs";

function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--join") flags.join = argv[++i];
    else if (a === "--config") flags.config = argv[++i];
    else if (a === "--channel") flags.channelId = argv[++i];
    else if (a === "--url") flags.url = argv[++i];
    else if (a === "--token") flags.token = argv[++i];
    else if (a === "--coding-cmd") flags.codingCmd = argv[++i];
    else if (a === "--chat-cmd") flags.chatCmd = argv[++i];
    else if (a === "--once") flags.once = true;
    else if (a === "--backfill") flags.backfill = true;
    else if (a === "--no-gate") flags.gate = false;
    else if (a === "-h" || a === "--help") flags.help = true;
    else positional.push(a);
  }
  return { cmd: positional[0] || "run", flags };
}

const HELP = `hilos-agent — your coding agent as a teammate in hilos

  hilos-agent --join <blob>      connect using a link copied from hilos
  hilos-agent init               write a starter config to ~/.hilos/agent.json
  hilos-agent                    run the daemon (watch @mentions, propose diffs)

Options:
  --channel <id>     watch only one channel (per-channel override)
  --config <path>    use a specific config file
  --coding-cmd <cmd> the coding agent to run (default: "claude -p")
  --chat-cmd <cmd>   fast command for chat replies + the plan-ack
                     (default: "claude -p --model claude-haiku-4-5")
  --once             one poll then exit (cron-friendly)
  --backfill         also act on mentions that predate startup
  --no-gate          propose only; don't wait for approval / push
  -h, --help         this help

Docs: https://hilos.sh  ·  https://www.npmjs.com/package/hilos-agent`;

async function main() {
  const { cmd, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || cmd === "help") {
    console.log(HELP);
    return;
  }

  const joinPayload = flags.join ? decodeJoin(flags.join) : undefined;
  if (flags.join && !joinPayload) {
    console.error("That --join link is invalid. Re-copy it from hilos.");
    process.exit(1);
  }

  if (cmd === "init") {
    const path = writeStarterConfig(joinPayload ? GLOBAL_CONFIG : flags.config, joinPayload || {});
    console.log(`Wrote ${path}.`);
    console.log(joinPayload ? "Token + endpoint set from your link." : "Fill in token + repos, then run `hilos-agent`.");
    console.log('Map your repos: "repos": { "owner/name": "/abs/path/to/checkout" }');
    return;
  }

  // run (default) — when --join is passed without init, connect straight away.
  const cliFlags = { ...flags };
  delete cliFlags.join;
  delete cliFlags.help;
  const cfg = resolveConfig({ flags: cliFlags, join: joinPayload });
  await run(cfg);
}

main().catch((e) => {
  console.error(e?.message || e);
  process.exit(1);
});
