# agensis-cli

Run a local agensis workspace agent daemon from your machine.

The npm package is `agensis-cli`; the installed command is `agensis`.
It connects to an agensis workspace over websocket, receives agent jobs, runs
your configured coding CLI in the local folder, and posts results back to the
workspace.

## Install

```sh
npm install -g agensis-cli
```

Or run without a global install:

```sh
npx --package agensis-cli agensis connect --help
```

## Connect An Agent

In agensis, open the agent profile, choose Connect, and copy the generated
command. It should look like:

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

- `--url <url>`: agensis app/backend URL, for example `https://agensis.io` or `http://localhost:5173`
- `--token <token>`: agent connection token from agensis
- `--workspace <id>`: workspace id
- `--agent <id>`: workspace agent id

Optional:

- `--handle <name>`: mention handle used in channels
- `--name <name>`: display name
- `--cwd <path>`: folder where the coding CLI runs
- `--coding-cmd <command>`: command used for jobs, default `claude -p`
- `--no-coding`: disable coding jobs while keeping presence or shared inference online
- `--model <id>`: default model passed to supported coding CLIs
- `--permission-mode <mode>`: `default`, `accept_edits`, or `yolo`
- `--yolo`: alias for `--permission-mode yolo`
- `--no-sandbox`: alias for `--permission-mode yolo`
- `--timeout-ms <ms>`: kill a job after this time, default `1800000`
- `--heartbeat-ms <ms>`: local terminal heartbeat interval, default `15000`
- `--share`: advertise the models in `--shared-models-file` to this workspace
- `--shared-models-file <path>`: JSON configuration for loopback OpenAI-compatible models
- `--once`: run one queued job then exit
- `--version`: print the CLI version
- `--help`: show help

Environment fallbacks:

- `AGENSIS_URL`
- `AGENSIS_TOKEN`
- `AGENSIS_WORKSPACE` or `AGENSIS_WORKSPACE_ID`
- `AGENSIS_AGENT` or `AGENSIS_AGENT_ID`
- `AGENSIS_HANDLE`
- `AGENSIS_NAME`
- `AGENSIS_CWD`
- `AGENSIS_CODING_CMD` or `CODING_CMD`
- `AGENSIS_NO_CODING=1`
- `AGENSIS_MODEL` or `CLAUDE_MODEL`
- `AGENSIS_PERMISSION_MODE`
- `AGENSIS_TIMEOUT_MS`
- `AGENSIS_HEARTBEAT_MS`
- `AGENSIS_SHARE=1`
- `AGENSIS_SHARED_MODELS_FILE`
- `AGENSIS_ONCE=1`

## Share Local Inference

The daemon can make a model running on the same machine available to its
Agensis workspace and a paired Agent Farm. The upstream endpoint must resolve
to loopback; private endpoint and key fields are never sent in the capability
advertisement.

```json
{
  "models": [
    {
      "id": "qwen3-8b",
      "name": "Qwen 3 8B",
      "provider": "ollama",
      "baseUrl": "http://127.0.0.1:11434/v1",
      "upstreamModel": "qwen3:8b",
      "capabilities": ["text", "streaming", "tools"],
      "maxConcurrency": 2
    }
  ]
}
```

```sh
agensis connect \
  --url https://agensis.io \
  --token aga_... \
  --workspace <workspace-id> \
  --agent <agent-id> \
  --share \
  --shared-models-file ./shared-models.json
```

Each model appears in the Agensis chat selector as a workspace-scoped route.
Inference requests relay over the existing authenticated daemon connection;
the model server does not need a public listener.

## Security

The daemon runs on your machine and executes the configured coding command in
the selected working directory. Your local credentials and filesystem stay
local; agensis sends the job payload and receives the result. Treat the daemon
like any local coding agent with access to the folder you start it in.

Farm-originated coding jobs use the same queue and can be cancelled by exact job
ID. A cancellation from the authenticated workspace aborts that process without
stopping work in another channel or queue lane.

Keep `aga_...` tokens out of shared logs and shell history. Generate a fresh
token from agensis if one is exposed.

## Release Checks

Before publishing `agensis-cli`, run:

```sh
npm run check
npm run pack:dry-run
```

The package publishes the `agensis` command from `bin/agensis.mjs`.
