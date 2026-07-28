# Terminal on web

How `TerminalPanel` gets a shell when the user is on agensis.io in a browser tab.
Investigation only — no code was written.

Scope, as narrowed: **the desktop path stays exactly as it is.** Electron already
runs node-pty in the main process over four IPC verbs (`electron/main.cjs:99-176`)
and remains the default on desktop. Everything below is the web path only, reusing
that same node-pty implementation over a different transport. Options 2 (pty on
the Fly container) and 3 (sandbox) are deprioritised; §2 records why in two
paragraphs and moves on.

## 1. Recommendation

**Put the pty in the user's own local daemon and relay its bytes over the
WebSocket that daemon already holds to Fly**, on a dedicated raw frame type that
bypasses the job machinery entirely.

The connectivity claim checks out against the code, and it is the whole reason
this is cheap. The daemon dials **out**: `new WebSocket(socketUrl(...))` at
`agensis.mjs:313`, where `socketUrl` builds `wss://<backend>/backend/ws`
(`agensis.mjs:725-733`). There is no inbound listener on the hub path — the only
listener in the daemon is `startLanListener()`, gated on `config.lanListener`
(`agensis.mjs:127-128`) and used solely for peer-to-peer LAN mesh. So the hard
part of "web terminal to my laptop" — inbound ports, NAT traversal, a tunnel — is
already solved, permanently, by a socket that exists for other reasons. The path
is browser → Fly (existing authenticated session) → existing daemon socket → pty
on the user's own machine.

That socket is genuinely full-duplex and the server already initiates on it: the
server pushes `{type:'agent_job', job}` (`server/agent-jobs.cjs:577-593`),
`{type:'agent_permission_decision'}` (`server/agent-permissions.cjs:364`),
`{type:'peer_ticket_grant'}` (`server/index.cjs:5676`) and bare drift nudges
`{type: nudge}` (`server/agent-connections.cjs:723`), and the daemon has a
standing dispatcher for all of them at `agensis.mjs:384-529`. A correlation
mechanism already exists and is worth copying rather than inventing:
`createInferenceBroker` (`server/inference-broker.cjs`) keys a `pending` Map by a
server-minted `requestId`, streams `agent_inference_delta` events back through an
`onEvent` callback, and — the part that matters for security — refuses any daemon
event whose `connectionId` does not match the one that took the request
(`inference-broker.cjs:60-61`). A pty relay is that same object with a longer
lifetime.

Cost: ~175 lines of server, ~120 frontend, ~130 daemon, and **zero schema
change**. The honest catch, stated once: this is unsandboxed code execution on a
human's laptop by design, so the authz check in §7 is not a detail, it is the
feature.

## 2. Why not the others (brief, as directed)

**A pty on the Fly machine.** `server/index.cjs` runs with `DATABASE_URL`,
`AUTH_SECRET`, `SECRETS_ENCRYPTION_KEY` and every provider key in its environment
(`AGENTS.md:369-383`). One `env` yields the ability to forge a session token for
any user on both backends and to decrypt every workspace's vault. Total
cross-tenant compromise from one feature. Also the wrong product: a shell in
`/app` has none of the user's files.

**A per-user sandbox container.** No lane exists to ride. `AGENTS.md:95-97` says
sandboxes are no longer a server feature; `server/sandbox-skills.cjs` is skill
definitions plus an HTTP credential proxy and never creates a container. The only
exec adapter is `packages/agensis-cli/src/sandbox/e2b.mjs:63-79` — `commands.run`
one-shots, no tty — and it runs **on the daemon** with the user's own key. So it
is option 1 plus a container. Revisit later as a second backend behind the same
`pty_spawn`; §9 keeps that door open.

## 3. Verdict: should a terminal be an agent template?

**You are right, and the code is more emphatic than your instinct was. Yes to the
surface, and an unambiguous no to the transport — the job loop cannot carry a
stream.** Four independent blockers, each fatal on its own:

1. **A job is hard-killed at 30 minutes no matter what.** `reapStuckAgentJobs`
   (`server/agent-jobs.cjs:303-323`) closes any running job where
   `started_at < now() - interval '30 minutes'`, and the comment at :300-302 says
   the ceiling exists precisely "so no amount of ticking can keep a job alive
   indefinitely". A terminal a human leaves open over lunch dies, correctly, by
   design. No keepalive defeats this, because defeating it is what the ceiling
   forbids.
2. **An open shell would make the agent look busy workspace-wide.** A partial
   unique index enforces one active job per `(session, agent)`
   (`agent-jobs.cjs:62-65`), and the queue drain uses `agentHasAnyActiveJob`,
   which is **workspace-wide** — "an agent that is mid-turn anywhere (a channel,
   another DM) is busy" (`agent-jobs.cjs:119-131`). So while a terminal was open,
   that agent could not answer a single message anywhere, and every dispatch to it
   would queue behind a shell.
3. **Every chunk would cost two Neon round-trips and a realtime fanout.**
   `handleAgentJobDelta` (`agent-jobs.cjs:753-813`) does a `SELECT` with a join,
   then an `UPDATE` rewriting the whole `metadata` jsonb wholesale, per delta —
   and downstream the placeholder message row is `UPDATE`d again, which broadcasts
   (`AGENTS.md:41-45`). At pty rates (`cat`, `npm install`, a held-down key) that
   is a database write storm.
4. **The delta path destroys terminal output.** It stores
   `textFromValue(...).trim()` and *replaces* rather than appends
   (`agent-jobs.cjs:770, 783`). Terminal output **is** whitespace and escape
   sequences; `.trim()` alone disqualifies it.

And the failure mode when the reaper wins is not silent: `finalizeStuckJob`
rewrites the placeholder with "@handle stopped responding … Send again to retry"
into a chat (`agent-jobs.cjs:228`). A closed terminal would post that.

**So: raw frame type on the same socket, bypassing the job machinery** — exactly
your expectation.

**Where the agent-template framing genuinely pays**, and it pays more than
expected, because a template is cheap. `AgentTemplate` is just a preset for a
`workspace_agents` row — `{id, name, handle, category, systemPrompt, tools,
skills, runMode, runtime, icon}` (`src/lib/agentTemplates.ts:31-51`), no runtime
behaviour attached. Registering a machine as an agent therefore inherits, for
free: the `agensis connect` onboarding, the connect-token / join-link auth
(`AGENTS.md:202-242`), workspace scoping, the online/offline dot and staleness
derivation already built in `useAgentConnections`
(`src/hooks/useAgentConnections.ts:16-28`), and the Agents window's per-agent
settings surface (where `--terminal` and host folders belong).

**One correction to the framing, though.** A terminal does not need a *new*
template, and defaulting to one would be a mistake: any daemon agent — Coder,
DevOps, QA (`agentTemplates.ts:117-139`) — is *already* a connected machine. The
mechanism should be a `capabilities.terminal` flag on the existing connection, so
every already-connected daemon becomes terminal-capable the moment its operator
opts in. A dedicated "Terminal" template is then worth adding as an *onboarding
path* for the one case it uniquely serves: "I want to connect this machine for a
shell, and I don't want it doing agent work." Template as a front door, not as the
mechanism.

## 4. Human + agent sharing one shell

**The proposed design makes this easy, and there is exactly one decision that
would foreclose it — so make it correctly on day one: the session's viewer field
must be a `Set` of sockets, never a single `browserWs`.** That is the whole cost
of keeping the door open.

Everything else already lines up. The pty lives in the daemon, which is the same
process that executes that agent's turns, so an agent reaching the shell is a
local Map lookup, not a new transport. Shared scrollback falls out of the fan-out:
the daemon emits one `pty_data` per chunk, the server copies it to every
subscriber in the set, and both the human's xterm and the agent's reader see the
identical byte stream in the identical order. Interleaved *input* is the same
`pty_write` frame from a different origin.

The open question is only how the agent addresses it, and it does not have to be
answered now:

- **Via MCP** (`server/mcp.cjs`) — a `terminal_write` / `terminal_read` tool. One
  authz path, one audit trail, symmetric with `call_provider`. Costs a round trip
  agent → Fly → back to the same daemon.
- **Locally in the daemon** — the agent's tool talks to the in-process Map
  directly. Faster, but it is a second authorization surface, which is how this
  repo has been bitten before.

Recommend MCP if it is ever built. Either way nothing in §5 changes: the session
key is `ptyId` and the ownership check is per-frame.

Two things worth designing in now because they are cheap and awkward to retrofit:
tag each `pty_write` with its origin (`human` / `agent`) so the UI can show who
typed, and keep a small output ring buffer per session in the daemon so a late
joiner (an agent, or a reloading browser) gets context rather than a blank screen.

## 5. Wire protocol

Three hops. Both ends of the middle hop are the same `/backend/ws`
(`server/realtime.cjs:330`); a human socket has `ws.userId`, a daemon socket has
`ws.agentAuth`/`ws.agentConnectionId` (`realtime.cjs:363-368`,
`agent-connections.cjs:573-575`). Naming follows the existing convention exactly:
**client→server frames use `action`**, **server→client frames use `type`**
(`realtime.cjs:433-518` dispatches on `message.action`; the daemon dispatches on
`message.type` at `agensis.mjs:384`).

### Browser → Fly

```jsonc
{ "action": "pty_spawn",  "workspaceId": "...", "agentId": "...", "cols": 80, "rows": 24 }
{ "action": "pty_write",  "ptyId": "...", "data": "ls -la\r" }
{ "action": "pty_resize", "ptyId": "...", "cols": 120, "rows": 40 }
{ "action": "pty_kill",   "ptyId": "..." }
```

`workspaceId`/`agentId` appear **only** on spawn. Later frames are addressed by
`ptyId` alone and resolved from the server's own map, so a browser can never
re-point a live session at another agent.

### Fly → browser

Rides the existing `system` event channel huddle STT uses (`realtime.cjs:458`,
consumed by `onSystemEvent` at `src/lib/backendClient.ts:872-874`), so no new
client-side plumbing:

```jsonc
{ "type": "system", "event": "pty", "payload": { "kind": "spawned", "ptyId": "...", "shell": "/bin/zsh", "cwd": "..." } }
{ "type": "system", "event": "pty", "payload": { "kind": "data",  "ptyId": "...", "chunk": "...", "origin": "human|agent" } }
{ "type": "system", "event": "pty", "payload": { "kind": "exit",  "ptyId": "...", "code": 0 } }
{ "type": "system", "event": "pty", "payload": { "kind": "error", "ptyId": "...", "message": "...", "code": "agent_offline|forbidden|no_pty|rate_limited|bad_cwd" } }
```

### Fly → daemon / daemon → Fly

```jsonc
{ "type": "pty_spawn",  "ptyId": "...", "cols": 80, "rows": 24, "cwd": "..." }
{ "type": "pty_write",  "ptyId": "...", "data": "..." }
{ "type": "pty_resize", "ptyId": "...", "cols": 120, "rows": 40 }
{ "type": "pty_kill",   "ptyId": "..." }

{ "action": "pty_started", "ptyId": "...", "shell": "/bin/zsh", "cwd": "..." }
{ "action": "pty_data",    "ptyId": "...", "chunk": "..." }
{ "action": "pty_exit",    "ptyId": "...", "code": 0 }
{ "action": "pty_error",   "ptyId": "...", "error": "...", "code": "no_pty|bad_cwd|spawn_failed" }
```

### Rules that make this a relay and not a routing table

- **The server mints `ptyId`** (`crypto.randomUUID()`), never the browser and
  never the daemon. A daemon frame naming an id it was not given is dropped.
- **Session state is `{ viewers: Set<ws>, userId, agentId, connectionId }`** — a
  Set from day one (§4).
- **Browser frames**: the session's `userId` must equal `ws.userId`.
- **Daemon frames**: the session's `connectionId` must equal
  `ws.agentConnectionId`. Identical to `inference-broker.cjs:60-61`, and the rule
  `AGENTS.md:70-73` states for permission decisions — a reconnected daemon is a
  new process and must not inherit a live pty.
- **No job row, no `agent_jobs` write, no message row.** That is the point of §3.
- **Backpressure is already handled**: `sendWs` drops rather than buffers past
  4 MB and never throws into the loop (`realtime.cjs:91-103`). Cap chunks at
  ~64 KiB daemon-side anyway.
- **UTF-8 strings, not base64.** node-pty's `onData` yields decoded strings and
  handles a codepoint split across reads; the Electron path relies on this
  (`electron/main.cjs:115-119`). Binary frames stay reserved for microphone PCM
  (`realtime.cjs:397-401`).

### Lifecycle

| Event | Action |
|---|---|
| A viewer's socket closes | Drop it from `viewers`; kill the pty when the set empties. Hook `ws.on('close')` at `realtime.cjs:530`. |
| Daemon connection goes offline | Emit `exit` to all viewers. Hook beside `inferenceBroker.failConnection(...)` at `agent-connections.cjs:299`. |
| Daemon socket drops (daemon side) | Kill all local ptys. **Deliberately unlike jobs**, which are held through `JOB_RECONNECT_GRACE_MS` (`agent-connections.cjs:259`): a job is work worth saving, a shell with no viewer is a liability. |
| Daemon superseded | Same as offline — `closeTakenAgentDaemons` routes through `markConnectionOffline` (`agent-connections.cjs:133`). |

## 6. Files to touch

### What factors out of `electron/main.cjs`, and the constraint on sharing it

The reusable core of `electron/main.cjs:81-176` is transport-agnostic:

- `loadPty()` — lazy `require('node-pty')` returning null on failure (:91-97).
- The session Map + id minting (:86-89).
- Spawn options: `name:'xterm-256color'`, `cols: Math.max(2, …)`,
  `rows: Math.max(1, …)`, `env: {...process.env, TERM:'xterm-256color'}` (:107-113).
- `write` / `resize` / `kill` bodies, including the dimension clamps (a zero
  dimension is a hard error inside the pty, :159-164) and the try/catch around
  `kill` (:169-173).
- The **owner-teardown rule**: ONE teardown listener per owner, not per session,
  because per-spawn registration trips Node's max-listeners warning at the tenth
  terminal and leaks a listener per exited session (:129-132). This is the single
  most valuable thing to carry across, and it generalises cleanly: "owner" is a
  `webContents` in Electron and a viewer set in the daemon.

Transport-specific and *not* shared: `ipcMain.handle`, `sender.isDestroyed()`,
`sender.send(channel, …)`, `sender.once('destroyed')` on the Electron side;
`send(ws, {action:'pty_data'})` and socket-close teardown on the daemon side.

**The constraint you should know before assuming one shared file:** these two live
in *different repositories*. `electron/main.cjs` is in this closed app repo; the
daemon is the public `jasonkneen/agensis-agent` repo, and `AGENTS.md:402-403`
forbids copying app code into it. A literally-imported shared module is therefore
not available without publishing a third npm package for ~70 lines, which is worse
than the problem. **Recommendation: deliberate duplication** — write `pty.mjs` in
the daemon as a direct port, with a header comment naming `electron/main.cjs:81-176`
as its sibling and calling out the max-listeners rule, so a future editor of either
knows the other exists. ~70 lines duplicated, knowingly. (The unification that
would actually remove it is making the *desktop* app use the daemon path too — out
of scope, §10.)

### Frontend — Netlify

| File | Change | ~Lines |
|---|---|---|
| `src/lib/backendClient.ts` | New `terminalRealtime` export beside `voiceRealtime` (:856-875): `spawn/write/resize/kill` via `realtimeManager.send`, events via `onSystemEvent('pty', …)`, plus `isOpen()`. | 45 |
| `src/components/windows/TerminalPanel.tsx` | `ptyBridge()` (:33-36) returns the Electron bridge when `window.electronAPI.pty` exists, else a WS-backed object satisfying the **same `PtyBridge` interface** (:19-31). Runtime feature-detect, exactly the `supportsWebviewTag()` shape at `BrowserPanel.tsx:42-46`; the web bundle imports nothing from Electron. Lines 85-157 untouched. Plus target picker + §11 copy. | 70 |
| `src/App.tsx` | Pass workspace connections / selected agent into `<TerminalPanel />` (:3297). | 5 |

### Backend — `fly deploy`

| File | Change | ~Lines |
|---|---|---|
| `server/pty-relay.cjs` *(new)* | `createPtyRelay({ sendWs, findConnectedAgent, enforceWorkspaceRole, … })` — factory shape matching `createInferenceBroker`. Session map with a viewer `Set`, id minting, both ownership rules, `failConnection`, `dropViewer`. | 135 |
| `server/realtime.cjs` | 4 browser + 4 daemon `message.action` branches inside the existing try/catch (:519-527) that already turns a throw into `{type:'error'}`; one line in `ws.on('close')` (:530); relay added to injected deps (:26-56). | 25 |
| `server/index.cjs` | Instantiate near `createInferenceBroker` (:267-278 — same closure trick, `sendWs` resolved at call time, not construction); `ptyRateLimiter`; pass into `createRealtime` (:6672-6683). | 20 |
| `server/agent-connections.cjs` | `ptyRelay.failConnection(...)` beside :299; `terminal` passthrough in `handleAgentCapabilitiesSync` (:855-881). | 3 |

`netlify/functions/backend.mjs` is **untouched** — no WebSockets
(`AGENTS.md:14-15`).

### Daemon — separate repo (`/Users/jkneen/Documents/GitHub/agensis-agent`)

| File | Change | ~Lines |
|---|---|---|
| `packages/agensis-cli/src/pty.mjs` *(new)* | The port described above. Plus: cwd validated against `[config.cwd, ...config.hostFolders]` (the existing `allowedRoots` rule at `agensis.mjs:1157`), `delete env.AGENSIS_TOKEN` before spawn (mirroring `cli.mjs:124`), an output ring buffer (§4), kill-all on teardown. | 100 |
| `packages/agensis-cli/src/agensis.mjs` | 4 `message.type` branches in the dispatcher (:384-529); a `terminal` config flag using the `booleanOption(raw.x, booleanOption(process.env.AGENSIS_X, default))` idiom at :693; `terminal:` in the capabilities snapshot; kill-all in `stop()` and on socket close. | 30 |
| `package.json` ×2 + `packages/agensis-agent/build.mjs` | `node-pty` as an **optionalDependency**, added to the esbuild `external` list (`build.mjs:38`) — the exact treatment `e2b` already has. | 5 |

### Tests

`tests/pty-relay.test.cjs`, modelled on `tests/inference-broker.test.cjs`: a
daemon frame for a session owned by another connection is dropped; a browser frame
for another user's `ptyId` is dropped; a `manage`-less caller is refused; a
connection going offline emits `exit` to every viewer. Top-level `tests/` only —
the glob does not recurse (`AGENTS.md:254-255`).

## 7. Auth + isolation

**Schema: no change.** `agent_connections.capabilities` is already jsonb and
`handleAgentCapabilitiesSync` writes a whole object
(`agent-connections.cjs:883-887`), so the three-place rule (`AGENTS.md:23-37`)
does not apply. Sessions are in-memory, like `connectedAgents` and
`pendingPeerTickets` (`index.cjs:5646`).

On `pty_spawn` only, in order:

1. `if (!ws.userId) return;` — a daemon socket must never open a pty on another
   daemon. The guard `voice_stt_start` uses at `realtime.cjs:456`.
2. `findConnectedAgent(workspaceId, agentId, '')`, which already requires
   `entry.workspaceId === workspaceId` (`agent-connections.cjs:172-175`). That
   closes the confused-deputy hole where a caller names a workspace they *do*
   manage while targeting an agent in one they don't.
3. **`await enforceWorkspaceRole(ws.userId, workspaceId, 'manage')`**
   (`index.cjs:667`).
4. `ptyRateLimiter` — `createRateLimiter({ windowMs: 60_000, max: 10 })`, spawn
   only, following `providerCallRateLimiter` (`index.cjs:2008`).
5. One `activity_events` row per spawn (`event_type='terminal_session'`), the
   audit shape `provider_call` uses (`AGENTS.md:140-142`). No DDL.

**Why `manage`, not `write`.** `MANAGE_ONLY_DB_COLUMNS_BY_TABLE` exists because
"a member with only 'write' could otherwise widen an agent's filesystem access to
`/` or `~/.ssh`" (`shared/backend-core.cjs:278-282`). A pty is strictly more
powerful than `--add-dir /`. Anything below `manage` contradicts a threat model
this repo has already decided.

**Daemon-side, non-negotiable:**

- **`--terminal` defaults OFF.** Server RBAC decides who may ask; the machine's
  operator decides whether it answers at all. Without this, shipping retroactively
  grants every workspace manager a shell on every already-running daemon — a
  capability nobody consented to when they ran `agensis connect`.
- **cwd validated against `[config.cwd, ...config.hostFolders]`** — the existing
  `allowedRoots` rule at `agensis.mjs:1157`. Reject with `bad_cwd`; never fall
  back to `$HOME` (correct at `electron/main.cjs:111`, wrong here).
- **`delete childEnv.AGENSIS_TOKEN`** before spawn. `cli.mjs:124` already does
  this for child processes; a pty that inherits it hands the shell's occupant the
  daemon's own workspace bearer token.
- Log every spawn locally so the machine's owner sees it in the daemon's own log.

**What an attacker gets if this is missing.** Remote code execution as the human's
own user on their own laptop — SSH keys, `~/.claude` credentials, `git push` to
every repo they can reach, the workspace token itself. Not a sandbox escape; there
is no sandbox. And because §3 removes the job row deliberately, without step 5 it
leaves **no trace in Activity at all** — that is the one thing the bypass costs,
and step 5 is how it is paid back.

## 8. Deploy targets

| File | Target |
|---|---|
| `src/lib/backendClient.ts`, `src/components/windows/TerminalPanel.tsx`, `src/App.tsx` | **Netlify** (auto-deploy on push) |
| `server/pty-relay.cjs`, `server/realtime.cjs`, `server/index.cjs`, `server/agent-connections.cjs` | **`fly deploy`** |
| `packages/agensis-cli/**`, `packages/agensis-agent/**` (separate repo) | **npm publish + every user restarts their daemon** |
| `electron/main.cjs`, `electron/preload.cjs` | **untouched** — desktop stays as-is |

Fly first, Netlify second (a frontend calling a route Fly does not yet have 404s
live). The daemon is the slow lane: the feature stays dark for anyone on an older
daemon, which is exactly what `capabilities.terminal` is for — absent ⇒ the panel
says the machine's agent is too old, rather than spawning into silence. Add a
`public/release-notes.json` entry (`AGENTS.md:299-307`).

## 9. When the daemon is offline — stated plainly

**If the laptop is shut, there is no terminal. Not a degraded one — none.**

This is inherent, not an implementation gap. The pty is a process on the user's
machine; if that machine is asleep, closed, or off the network, there is nothing
to attach to and no server-side substitute, because a shell on Fly would be a
different computer with none of their files (§2). A user on their phone with their
laptop shut gets a clear "that machine is offline", and that is the correct and
permanent answer for this design.

Concretely: `useAgentConnections` already derives offline from a stale
`last_seen_at` at 45 s — 3× the 15 s heartbeat (`useAgentConnections.ts:6-20`) —
so the panel knows within ~45 s with no new plumbing, and the server's liveness
sweep terminates a dead socket within ~30 s (`realtime.cjs:67-70, 540-555`). A
session that was open when the lid closed is gone, not suspended: the daemon kills
its ptys on socket close (§5), and there is no reattach.

What this rules out as a product promise: "check on a build from my phone" only
works while the machine is awake. If that use case matters, the honest answer is
the sandbox lane (§2) as a *second* backend behind the same `pty_spawn` — a shell
that survives a closed laptop is by definition not a shell on that laptop.

Mitigations worth considering, none of which change the above: `caffeinate`-style
guidance for users who want a machine to stay reachable, and a visible last-seen
timestamp in the offline copy so "offline" reads as "your Mac is asleep" rather
than "agensis is broken".

## 10. Open questions

1. **Is "workspace manager" the right blast radius?** `manage` grants a shell on
   every connected member's laptop in the workspace. `--terminal` (default OFF)
   bounds this to machines whose operator agreed, which I think is the real gate —
   but restricting further to `workspace_agents.created_by === ws.userId` (the
   column exists at `database/neon-schema.sql:380`; I did **not** verify it is
   enforced as an ownership boundary anywhere today) is a human call.
2. **node-pty install friction.** Native module. As an optionalDependency a failed
   build leaves `npm i -g @agensis/agensis-agent` succeeding with the terminal
   unavailable — the `e2b.mjs:34-36` refusal shape. **Unverified** whether node-pty
   ships prebuilds covering the Node versions users actually run. If not, the
   fallback worth considering is `script -q /dev/null $SHELL` (a real tty, no
   native dependency, but BSD/util-linux flags differ and there is no resize).
3. **A dedicated "Terminal" template — yes or no?** §3 argues it is a useful
   onboarding front door but must not be the mechanism. Confirm you want it at all,
   or whether `capabilities.terminal` on existing daemon agents is enough for v1.
4. **Reattach on browser reload?** Recommend no for v1 — a reload gets a fresh
   shell. The §4 ring buffer would make a limited reattach cheap later.
5. **Concurrent sessions per daemon** — cap, and at what number? Electron has none
   (`main.cjs:86-89`).
6. **Should a remote shell opening be announced in the workspace**, not just the
   daemon's local log — e.g. a line in the agent's DM? Cheap, and it makes an
   unwanted session visible to the machine's owner in seconds.
7. **Long term: should desktop move onto the daemon path too**, collapsing the §6
   duplication? It would mean the desktop app needs a local daemon — a product
   decision well beyond this task.

## 11. Offline / failure UX

The panel's existing status enum (`'starting' | 'ready' | 'unavailable' |
'exited'`, `TerminalPanel.tsx:72`) plus `detail` covers every case — no new states:

| Situation | Status | Copy |
|---|---|---|
| No `electronAPI.pty`, no realtime socket | `unavailable` | "The terminal needs the desktop app or a connected machine." |
| No online daemon in the workspace | `unavailable` | "No connected machine. Run `agensis connect` on the machine you want a shell on." |
| Daemon offline (§9) | `unavailable` | "*<name>* is offline — last seen 14 minutes ago. Wake that machine to open a shell." |
| Daemon online, `capabilities.terminal !== true` | `unavailable` | "This machine's agent doesn't offer a terminal. Update it, or start it with `--terminal`." |
| Daemon has no node-pty (`no_pty`) | `unavailable` | The daemon's own install hint, passed through — same shape as `e2b.mjs:34-36`. |
| Caller lacks `manage` (`forbidden`) | `unavailable` | "You need the manage role in this workspace to open a shell." |
| Rate limited | `unavailable` | "Too many terminals opened. Try again in a minute." |
| cwd rejected (`bad_cwd`) | `unavailable` | "That folder isn't shared by this machine's agent." |
| Daemon drops mid-session | `exited` | "Session ended — the machine disconnected." + Reconnect (fresh shell). |
| Shell exits normally | `exited` | Existing "Shell exited (code)" at `TerminalPanel.tsx:118`. |
| Realtime cooling down (`backendClient.ts:696-709`) | `unavailable` | "Connection lost — reconnecting." |

**One trap to handle explicitly.** `RealtimeManager.ensureConnected()` returns
early when `this.channels.size === 0` (`backendClient.ts:474`), and `send()` queues
into `pendingMessages` before calling it (:648-652). A terminal opened on a screen
with no active channel subscription would queue frames forever and show nothing.
`terminalRealtime` must gate on `realtimeManager.isOpen()` (:675-677) and surface
"Connection lost" rather than hang. In practice the app always has channels
subscribed — which is precisely why this gets missed in testing and hits a user.
