# @agensis/agensis-agent

Run a local [agensis](https://agensis.io) workspace agent daemon from your machine.

It connects to an agensis workspace over WebSocket, receives `@mention` jobs,
runs your configured coding CLI in the local folder, and posts results back to
the workspace. The installed command is `agensis`.

## Install

```sh
npm install -g @agensis/agensis-agent
```

Or run without installing:

```sh
npx @agensis/agensis-agent agensis --help
```

## Connect an agent

In agensis, open the agent profile, choose **Connect**, and copy the generated
command. It looks like:

```sh
agensis connect \
  --url https://agensis.io \
  --token aga_... \
  --workspace <workspace-id> \
  --agent <agent-id> \
  --handle general \
  --name general \
  --model claude-haiku-4-5 \
  --permission-mode default
```

Run it from the folder where the coding CLI should execute:

```sh
cd /path/to/repo
agensis connect --url ... --token ... --workspace ... --agent ...
```

The command stays connected, sends heartbeats, accepts queued jobs, and exits on
Ctrl+C.

## Options

Required:

- `--url <url>` — agensis app/backend URL, e.g. `https://agensis.io` or `http://localhost:5173`
- `--token <token>` — agent connection token from agensis
- `--workspace <id>` — workspace id
- `--agent <id>` — workspace agent id

Optional:

- `--handle <name>` — mention handle used in channels
- `--name <name>` — display name
- `--cwd <path>` — folder where the coding CLI runs
- `--coding-cmd <command>` — command used for jobs (default `claude -p`)
- `--model <id>` — default model passed to supported coding CLIs
- `--permission-mode <mode>` — `default`, `accept_edits`, or `yolo`
- `--yolo` / `--no-sandbox` — alias for `--permission-mode yolo`
- `--timeout-ms <ms>` — kill a job after this time (default `1800000`)
- `--heartbeat-ms <ms>` — heartbeat interval (default `15000`)
- `--once` — run one queued job then exit
- `--version` — print the CLI version
- `--help` — show help

Environment fallbacks: `AGENSIS_URL`, `AGENSIS_TOKEN`,
`AGENSIS_WORKSPACE` / `AGENSIS_WORKSPACE_ID`, `AGENSIS_AGENT` / `AGENSIS_AGENT_ID`,
`AGENSIS_HANDLE`, `AGENSIS_NAME`, `AGENSIS_CWD`, `AGENSIS_CODING_CMD` / `CODING_CMD`,
`AGENSIS_MODEL` / `CLAUDE_MODEL`, `AGENSIS_PERMISSION_MODE`, `AGENSIS_TIMEOUT_MS`,
`AGENSIS_HEARTBEAT_MS`, `AGENSIS_ONCE=1`.

## Security

The daemon runs on your machine and executes the configured coding command in
the working directory you start it in. Your local credentials and filesystem
stay local; agensis sends the job payload and receives the result. Treat it like
any local coding agent with access to that folder.

Keep `aga_...` tokens out of shared logs and shell history. Generate a fresh
token from agensis if one is exposed.

## Requirements

- Node.js >= 18

## License

[MIT](./LICENSE)
