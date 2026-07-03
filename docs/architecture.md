# agensis — Architecture

> One workspace, many agents, run anywhere, behave as one team.
> Diagram + layer map grounded in the actual repo (`server/`, `agent/agensis-cli/`, `src/`, `database/`).

## System diagram

```mermaid
flowchart TB
    subgraph clients["🖥️  CLIENTS"]
        direction LR
        web["Web SPA — agensis.io<br/>React + TS + Vite + Tailwind + shadcn/radix<br/>(src/)"]
        desktop["Desktop app<br/>Electron wrapper<br/>(electron/)"]
        pwa["PWA<br/>vite-plugin-pwa"]
    end

    subgraph edge["☁️  EDGE / HOSTING"]
        netlify["Netlify<br/>static hosting + @netlify/identity (auth)<br/>auto-deploy on push to main"]
    end

    subgraph backend["⚙️  BACKEND HUB  —  Fly.io  (server/index.cjs, single always-on machine)"]
        direction TB
        rest["REST API<br/>/backend/* — workspaces, agents,<br/>channels, messages, docs, tasks, files"]
        ws["WebSocket hub<br/>/backend/ws (ws)<br/>realtime sync · presence · cursors · heartbeats"]
        orch["Orchestrator / dispatch<br/>continueConversation · auto-interject<br/>burst-job liveness · thread split/merge"]
        mcp["MCP server<br/>server/mcp.cjs<br/>external MCP clients act as agents"]
        files["File service<br/>fs.createReadStream<br/>.agensis_uploads (ephemeral)"]
    end

    subgraph data["🗄️  DATA"]
        neon[("Neon Postgres<br/>@netlify/database<br/>database/neon-schema.sql<br/>workspaces · agents · sessions ·<br/>messages · agent_jobs · connections ·<br/>thread_items · secrets · memory")]
    end

    subgraph agents["🤖  AGENT RUNTIMES  (run_mode)"]
        direction TB
        daemon["Local daemon  (run_mode='daemon')<br/>agent/agensis-cli — agensis.mjs · queue.mjs · state.mjs · memory.mjs<br/>spawns  claude -p --model  → USER'S OWN Claude sub<br/>heartbeat 15s · ~/.agensis/&lt;ws&gt;/&lt;agent&gt;/ state mirror"]
        builtin["Server-managed  (run_mode='builtin')<br/>runs inside the hub via platform/workspace key"]
        external["External MCP  (run_mode='external')<br/>any MCP client backs an agent via join token"]
    end

    subgraph models["🧠  INFERENCE PROVIDERS"]
        direction LR
        anthropic["Anthropic API<br/>Claude (Opus/Sonnet/Haiku/Fable)"]
        openrouter["OpenRouter<br/>rotating FREE models<br/>(planned managed path)"]
    end

    subgraph pay["💳  BILLING (planned)"]
        stripe["Stripe Billing<br/>entitlement gate at<br/>getAnthropicApiKey / dispatch"]
    end

    web --> netlify
    desktop -.bundles.-> web
    pwa -.-> web
    netlify -->|HTTPS REST| rest
    netlify -->|WSS realtime| ws
    web -.mcpConnect / realtimeManager.-> ws

    rest --> neon
    ws --> neon
    orch --> neon
    mcp --> neon
    files --> neon

    ws <-->|persistent socket + heartbeat| daemon
    orch -->|dispatch jobs| daemon
    orch --> builtin
    mcp <--> external

    daemon ==>|$0 — user's tokens| anthropic
    builtin -->|platform/workspace key| anthropic
    builtin -.planned.-> openrouter
    orch -.entitlement check.-> stripe

    classDef free fill:#0d3b26,stroke:#1f9d63,color:#d7ffe9;
    classDef cost fill:#3b1f0d,stroke:#c47a2a,color:#ffe9d7;
    classDef planned stroke-dasharray:5 5,opacity:0.75;
    class daemon,anthropic free;
    class builtin cost;
    class openrouter,stripe,external planned;
```

## Layer map

| Layer | What it is | Where |
|---|---|---|
| **Clients** | React + TypeScript SPA (Vite, Tailwind, shadcn/radix). Same bundle powers the Electron desktop app and a PWA. Windowed canvas UI, chat, docs, tasks, themes (classic/neo/tinyworld). | `src/` (components, hooks, lib, providers) |
| **Client data plane** | Custom query builder over the backend (`backendClient.ts`), realtime subscriptions (`realtimeManager.ts`), MCP connect (`mcpConnect.ts`), offline cache (`offlineDb.ts`). | `src/lib/`, `src/hooks/` |
| **Edge / hosting** | Netlify serves the static build (auto-deploys on push to `main`) and provides identity/auth via `@netlify/identity`. | `netlify/`, Netlify |
| **Backend hub** | One Express process on Fly.io = REST + a `ws` WebSocket hub at `/backend/ws` + the agent orchestrator + an MCP server + a file service. Single always-on machine (`min_machines_running=1`). | `server/index.cjs`, `server/mcp.cjs`, `shared/backend-core.mjs`, `fly.toml`, `Dockerfile.fly` |
| **Orchestration** | Dispatches turns (`continueConversation`), auto-interject picks one agent to reply in `auto` channels, burst-job liveness prevents phantom-job wedges, thread split/merge, comment→DM mention dispatch. | `server/index.cjs` |
| **Data** | Neon Postgres (serverless, scale-to-zero). Stores everything except file bytes: workspaces, agents, chat_sessions, messages, `agent_jobs`, `agent_connections`, `thread_items`, `workspace_secrets`, memory. | Neon, `database/neon-schema.sql` |
| **File storage** | Upload bytes on local disk (`.agensis_uploads`), served via `fs.createReadStream`; only metadata + `content_sha256` (dedupe) in Neon. ⚠️ Fly volume not mounted → uploads are ephemeral across deploys. | `server/index.cjs` |
| **Agent runtimes** | Three `run_mode`s: **daemon** (local CLI, spawns `claude -p` on the user's own Claude sub — $0 inference), **builtin** (runs in the hub on the platform/workspace key), **external** (any MCP client backs an agent via a join token). | `agent/agensis-cli/src/` |
| **Inference** | Daemon path → Anthropic on the user's tokens (free to platform). Managed path → `getAnthropicApiKey` resolves a workspace secret, else the platform key. Planned: rotating **OpenRouter free models** for the managed path; frontier stays BYO-key. | `resolveSecret` / `getAnthropicApiKey` in `server/index.cjs` |
| **Billing (planned)** | Stripe Billing; entitlement gate goes server-side at `getAnthropicApiKey` / dispatch (where money is spent), not in React. | `docs/pricing/` |

## The two things that define the economics

1. **Daemon inference is free to the platform.** The local daemon shells out to `claude -p --model` using the *user's* Claude subscription. N daemons on N machines cost the hub ~nothing beyond a WebSocket.
2. **Managed inference is the only real cost lever.** Anything running on the platform key (auto-interject, builtin agents) spends real tokens — which is why the entitlement gate and the planned OpenRouter-free-models path both live on that single path.

## Realtime & liveness spine

- Daemons hold a persistent socket to `/backend/ws` and **heartbeat every 15s**, now carrying `capabilitiesHash` + `memoryHash` so skills/tools/memory drift is detected and re-synced.
- Each daemon mirrors state to `~/.agensis/<ws>/<agent>/` (`heartbeat.json`, `soul.md`, `status.json`) and can write its own status back.
- `agent_jobs` liveness ties a job's validity to its connection; phantom (NULL/dead-connection) jobs are finalized instead of wedging a session.

_Deploy split to remember: frontend ships on Netlify (push to `main`); the backend on Fly.io is a **manual `fly deploy`**; daemons pick up CLI changes on restart._
