# Desktop app (Electron) — local development setups

How to run the **Electron** desktop shell day-to-day, including **local Relay**
agents (“Start on this Mac”) and pairing with **live web**.

Code: `electron/` · launchers: `scripts/desktop-dev.mjs`, `scripts/desktop-build.mjs`  
Ship/sign: [RELEASING.md](../RELEASING.md)

> **Not** the Zig/Native SDK folder under `desktop/` — see
> [desktop/README.md](../desktop/README.md). Normal work uses Electron.

---

## The one rule

**The UI and the local runtime bridge must use the same backend.**

“Online” means: this agent has an open WebSocket **on that backend process**
(`isConnectionSocketLive`). local runtime running on your Mac is not enough if the bridge
registered somewhere else.

| Surface | Backend |
| --- | --- |
| Live web (agensis.io) | Always **Fly** |
| Local web (`npm run dev:full`) | Local **`:3142`** |
| Local runtime process | Always **this Mac** (stdio) |
| Local runtime **daemon** | Must match the UI you care about |

---

## Local development setups

Two supported recipes. Pick one and stick to it for a session.

### Setup A — fully local (desktop + backend on this machine)

Use when: iterating on app UI or local runtime without touching production.

```bash
# From repo root (after npm install, .env, migrate as usual)
npm run desktop:dev:local
# alias: npm run desktop:dev
```

What starts:

1. Local backend on **`:3142`** (if not already running)
2. Vite on **`http://127.0.0.1:5173`** (HMR)
3. Electron loading that Vite URL, with `VITE_BACKEND_BASE_URL=http://127.0.0.1:3142`

Then:

1. Sign in (local backend / your `.env` Neon or local Postgres).
2. Agents → **Start on this Mac** for each agent.
3. Confirm **Electron main** log (not only renderer):

```text
[desktop-local] bridge start … ws=ws://127.0.0.1:3142/backend/ws
[desktop-local] authenticated agent=…
[desktop-local] registered agent=…
```

| Works | Does not |
| --- | --- |
| Desktop UI, local Relay, local chat/dispatch | Live web (agensis.io) staying green for these agents |

Optional: browser at `http://127.0.0.1:5173` against the same local backend (if
Vite is already up from the desktop script, or run `npm run dev:full` instead
of desktop for browser-only).

---

### Setup B — local desktop + live web (prod backend)

Use when: local SDK runtimes on your Mac, but you want **agensis.io** (and any other
client on Fly) to see the agents online and stream turns.

```bash
npm run desktop:dev:prod
# alias: npm run desktop:dev:live
```

What starts:

1. **No** local `:3142`
2. Vite on **`http://127.0.0.1:5173`** (HMR), with  
   `VITE_BACKEND_BASE_URL=https://agensis-backend.fly.dev`
3. Electron → same Vite URL; API/WS/local runtime mint all go to **Fly**

Then:

1. Sign in with the **same account/workspace** as live web.
2. If these agents were previously started against local, **Stop** them.
3. **Start on this Mac** again (re-mints token + saves Fly `baseUrl` for restore).
4. Confirm main log:

```text
[desktop-local] bridge start … ws=wss://agensis-backend.fly.dev/backend/ws
[desktop-local] authenticated agent=…
[desktop-local] registered agent=…
```

5. Refresh **https://agensis.io** — agents should stay green (not “green ~10s then off”).

| Works | Does not |
| --- | --- |
| Desktop HMR + Fly data | Using local `:3142` for the bridge while web is on Fly |
| Live web sees agents online and streams | Expecting live web to see purely local-registered agents |

---

### Switching A ↔ B mid-session

1. Quit Electron / stop the dev script.
2. Start the other command (`desktop:dev:local` or `desktop:dev:prod`).
3. **Re-Start every local agent** so connect token + autostart `baseUrl` match.

Autostart after reboot restores the **last** `baseUrl` you saved. After a switch,
re-Start once so restore does not reattach to the wrong backend.

---

### Browser-only local (no Electron)

```bash
npm run dev:full          # :3142 + Vite (see root README)
# open the Vite URL from the script output
```

No “Start on this Mac” (that needs Electron). Use classic
`agensis connect` (Relay CLI, not local runtime) for local agents, or desktop **Start on this Mac** for Relay via Claude Agent SDK / Codex app-server.

---

## Command cheat sheet

### Dev (hot reload)

| Command | Backend | Local `:3142` | Live web sees agents |
| --- | --- | --- | --- |
| `npm run desktop:dev:local` | `http://127.0.0.1:3142` | Started if needed | No |
| `npm run desktop:dev:prod` | Fly | Skipped | **Yes** |

Aliases: `desktop:dev` / `electron:dev` → local · `desktop:dev:live` → prod  

Override: `VITE_BACKEND_BASE_URL=https://… npm run desktop:dev`

### Package (not hot reload — installers)

| Command | Baked backend |
| --- | --- |
| `npm run desktop:build:local` / `desktop:dist:local` | `:3142` |
| `npm run desktop:build:prod` / `desktop:dist:prod` | Fly (default ship) |

`desktop:build` / `desktop:dist` default to **prod**. These are **not** the
dev loop. Arch: **mac arm64 only** (no Rosetta). Signing: keychain Developer ID
when present; full notarize → `npm run desktop:ship` ([RELEASING.md](../RELEASING.md)).

Unsigned local package smoke:

```bash
CSC_IDENTITY_AUTO_DISCOVERY=false SKIP_DESKTOP_SIGN_VERIFY=1 npm run desktop:dist:local
```

---

## Connect dialog (Agents window)

Per-agent **Connect** (not the workspace MCP control-plane dialog):

| Tab (desktop) | Tab (browser) | What it is |
| --- | --- | --- |
| **This Mac** | **CLI** | Desktop: local runtime Start/Stop first. Optional: `agensis-agent` CLI command. |
| **MCP** | **MCP** | Agent token + MCP client config (not local harness). |
| **Webhook** | **Webhook** | HTTP wake URLs. |

Copy must stay accurate:

- Backend target is shown from `apiBaseUrl()` (local `:3142` vs Fly).
- **Model** is on the agent (compact **AgentModelPicker** on agent detail + Connect → This Mac), same idea as other desktop hosts — not in the human chat composer. Changing model while local runtime is running shows **Restart to apply**.
- Regenerating MCP token invalidates local SDK runtime / CLI until re-Start.
- CLI “service install” is only for the Relay CLI host, not local SDK runtime autostart.

## Local runtime details

### What “Start on this Mac” does

1. Mint connect token: `POST /backend/agents/:id/connection-command`
2. Prefer mint `baseUrl`, else `apiBaseUrl()` (set by `VITE_BACKEND_BASE_URL` in
   desktop-dev)
3. Main process: spawn harness (`electron/local-runtime/supervisor.cjs`)
4. Daemon child (`agensis connect --no-acp`): `auth` → `agent_register` →
   heartbeats / `agent_job_*`
5. Optional autostart: userData profile + encrypted token (restore after reboot)

### Runtime pin

If `workspace_agents.metadata.runtime` is `claude` | `codex` | `amp`, the bridge
must declare the same `executionRuntime` or register fails (`runtime_mismatch`).
Match harness to pin, or clear the pin.

### Job wire (finish without wiping the stream)

| Frame | Field for body |
| --- | --- |
| `agent_job_delta` | `content` (also accepts `response`) |
| `agent_job_result` | **`response`** (+ `error`) — not `content` alone |

Wrong field on the final frame → server overwrites a good stream with  
`@handle finished without output.`

### Healthy reconnect

Close → ~2s → `authenticated` → `registered` → quiet heartbeats.  
Not healthy: online/offline every few seconds.

---

## Console noise in desktop:dev (ignore)

| Log | Why |
| --- | --- |
| `[vite] connected` | HMR OK |
| GoTrue “DO NOT USE HTTP IN PRODUCTION” | Identity settings probe from `http://127.0.0.1:5173` |
| WS closed before established | React Strict Mode double-mount |
| Electron CSP `unsafe-eval` | Unpackaged only |
| `/version.json` 404 | Prod update file; not emitted by Vite dev |
| Scramjet / bare-mux / IDB | In-app **Browser** panel, not local runtime |

---

## Code map

| Path | Role |
| --- | --- |
| `scripts/desktop-dev.mjs` | Dev: local vs prod |
| `scripts/desktop-build.mjs` | Package: backend bake, arch, sign env |
| `electron/main.cjs` | Window, local runtime IPC |
| `electron/preload.cjs` | `window.electronAPI.acp.*` |
| `electron/local-runtime/supervisor.cjs` | Spawns `agensis connect --no-acp` |
| `electron/local-runtime/autostart.cjs` / `restore.cjs` | Reboot restore |
| `electron/local-runtime/resolveBinary.cjs` | Find `agensis` on PATH |
| `shared/local-agent-discovery.cjs` | Find harness CLIs |
| `src/components/windows/AgentsWindowContent.tsx` | Start/Stop UI |
| `src/hooks/useAgentConnections.ts` | Connection list / seed rules |
| `server/agent-jobs.cjs` | Result/delta handlers (`response` field) |

---

## Quick checklist

```bash
# A — all local
npm run desktop:dev:local
# Start on this Mac → ws://127.0.0.1:3142

# B — desktop HMR + live web
npm run desktop:dev:prod
# Start on this Mac → wss://agensis-backend.fly.dev
# Same workspace on https://agensis.io
```
