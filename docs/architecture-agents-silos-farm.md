# Agents, silos, and the Farm — how it all connects

> Status: reference. The open-source `agensis-agent` extraction is complete.

## The three repos

| Repo | Visibility | Role |
|---|---|---|
| Private Agensis app repository (this repo) | **closed** | The agensis.io web app + server. The relay, workspace, chat, and agent registry. |
| `jasonkneen/agensis-agent` | **open** | The daemon a machine runs to connect a coding CLI as an agent. Published to npm as `@agensis/agensis-agent`. |
| `jasonkneen/Agent-Farm-CLI` | **open** | The `farm` CLI: creates/drives *distributed* silos (remote machines, E2B, Daytona) and pairs them into an Agensis workspace. |
| `jasonkneen/Agent-Farm-web-desktop` | **closed** | The GUI for the Farm CLI (the `desktop/` surface). |

Agensis is the hub. The agent daemon is how a machine joins it. The Farm is an
optional control plane that provisions many machines/sandboxes and pairs them in.

## One hard vocabulary rule (read this first)

**"Silo" is a Farm word, not an Agensis word.** Internally Agensis has no silo
table and no silo type. Its primitives are:

- **Agent** (`workspace_agents`): a named participant with a `run_mode`.
- **Connection** (`agent_connections`): a live daemon socket for an agent.

The `/backend/integrations/farm/silos` endpoint is a **farm-facing projection**
(`server/index.cjs`): it joins live connections to their agents and relabels each
one a "silo" for the Farm's vocabulary. So:

> **A Farm "silo" IS an Agensis daemon (or sandbox) agent, seen from the Farm side.**

When you read "silo" in Farm docs and "agent" in Agensis code, they are the same
running thing viewed through two lenses. Do not introduce a `silo` concept into
the Agensis data model; keep it as a projection at the integration boundary.

## The four ways inference actually runs

Agensis agents resolve to exactly one of four runtimes (`run_mode`):

| `run_mode` | Who runs the model | Credentials | Example |
|---|---|---|---|
| `builtin` | The **agensis server itself**, on the platform (or per-workspace) `ANTHROPIC_API_KEY` | Held by agensis (Fly env / workspace vault) | General, Scout, seeded Claude agents |
| `daemon` | A **remote machine's coding CLI** reached over the daemon WebSocket | Stay on that machine; never touch agensis | `@coder` on a laptop, a Farm-enrolled box |
| `sandbox` | A **managed cloud runtime** (E2B/Daytona) running the daemon inside it | Baked into the sandbox template/snapshot | `farm silo create e2b …` |
| `external` | An **external Connector client** acting as the agent through MCP | Held by that client; agensis queues work until it polls | A registered MCP Connector |

There is also a separate, orthogonal path — **gateway configs**
(`gateway_configs`): a workspace-level named route to an external
OpenAI-compatible endpoint, selected per-chat as `gateway:<id>`. This is not an
agent; it is a direct server→upstream inference route (see
`docs/architecture-agents-silos-farm.md` sibling: the gateway feature).

## How a machine joins: the daemon

Source of truth: `../agensis-agent/packages/agensis-cli/src/agensis.mjs` in the
public repository (→ published bundle `@agensis/agensis-agent`). The web app
**never imports** the daemon — the only
references in `src/`/`server/` are string tags (`source: 'agensis-cli'`,
`runtime: 'agensis-cli'`), so the daemon is a clean leaf, safe to extract.

```text
machine:  agensis connect --url … --token aga_… --workspace … --agent …
            │  outbound WebSocket (no inbound port)
            ▼
agensis:  /backend/ws  ──registers──> agent_connections (presence, capabilities)
            │
            ▼
          a chat @mention or dispatch → agent_job → daemon runs the coding CLI
            in its cwd (+ any --host-folder as --add-dir) → streams result back
```

Host folders (0.1.25): `--host-folder` / `workspace_agents.metadata.host_folders`
→ forwarded on dispatch → daemon passes each as `--add-dir` to the coding CLI.
This is the agensis-native equivalent of the Farm's "share host dir into silos".

## How the Farm fits on top

The Farm never replaces the daemon — it **orchestrates many daemons/sandboxes**
and pairs them into one workspace.

```text
            ┌──────────────────────────── Farm CLI / desktop ────────────────────────────┐
            │  farm pair --url agensis.io   → device code → approve at                     │
            │      agensis.io/integrations/farm?code=FARM-XXXX-XXXX                        │
            │      → agf_ token @ ~/.usage-farm/integrations/agensis/<workspace-id>.json   │
            │                                                                              │
            │  farm silo create e2b|daytona  → POST /backend/integrations/farm/agents      │
            │      → agensis mints a daemon agent + aga_ child token                       │
            │      → Farm launches agensis-cli INSIDE the sandbox with that token          │
            │                                                                              │
            │  farm silos  → GET /backend/integrations/farm/silos (the projection)         │
            │  farm job    → POST /backend/integrations/farm/jobs (sessionless agent_job)  │
            └──────────────────────────────────────────────────────────────────────────────┘
```

Pairing flow (device-code), both sides verified in source:

1. Farm: `agensis-client.mjs` → `POST /backend/integrations/farm/device/start`
   → gets `FARM-XXXX-XXXX` user code + `agd_` device code (10-min TTL).
2. Human: opens `agensis.io/integrations/farm?code=…`, signs in, picks ONE
   workspace, approves scopes → `POST …/device/approve` binds the code.
3. Farm: polls `POST …/device/token` → exchanges `agd_` for a scoped `agf_`
   integration token. Stored owner-only.
4. Farm now calls `/silos`, `/agents`, `/jobs` with `Authorization: Bearer agf_…`.

Farm scopes (`server/farm-integration.cjs`): `workspace:read`, `agents:read`,
`agents:enroll`, `agents:dispatch`, `models:read`, `models:invoke`.

## The credential-isolation invariant (shared across all three)

Provider keys never cross a boundary they don't have to:

- **builtin** → key on agensis (Fly / workspace vault).
- **daemon** → key on the machine; agensis only relays the job payload.
- **sandbox** → key baked into the sandbox; Farm injects only the `aga_` child
  connection token, never provider creds.
- **Farm silo descriptors** (`~/.usage-farm/silos/`) hold routing/lifecycle
  metadata ONLY — no tokens/keys. The `agf_` pairing token is the sensitive
  counterpart and is owner-only.
- **gateway configs** → API key encrypted at rest (`api_key_cipher`, AES-256-GCM
  via the workspace vault); never returned to the client.

## Shared local inference (the overlap that confuses people)

A daemon can also *advertise* a loopback model (Ollama/LM Studio) with
`--share --shared-models-file`. Agensis turns it into a workspace route
`agensis/<workspace-id>/<agent-id>/<model-id>` that shows up in the chat model
selector AND in `farm models`. The private base URL/key are stripped from the
capability advert; the daemon performs every request locally. This is distinct
from a **gateway config** (server-side, external endpoint) — same user-visible
"pick a model", two different mechanisms:

| | Shared daemon model | Gateway config |
|---|---|---|
| Runs where | On the daemon machine (loopback) | agensis server → external URL |
| Model id | `agensis/<ws>/<agent>/<model>` | `gateway:<id>` |
| Needs a daemon | Yes | No |
| Key location | On the machine (never sent) | Encrypted in agensis vault |

## Repository split

The split is complete: this repository remains closed and owns Agensis web,
backend, database, and desktop code. The daemon source and npm release process
live in the public `jasonkneen/agensis-agent` sibling repository. See the
completed migration record in `docs/rename-and-agent-extraction.md`.
