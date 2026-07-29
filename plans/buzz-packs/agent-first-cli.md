# Pack: agent-first-cli — "Agent-first CLI"

Source pack: `/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/agent-first-cli/`
Rank 2, priority 93. Domain `cli`. Stated targets: `agensis-agent` + `agensis`.
Planned 2026-07-29 against branch `main-next`, Fly v126, npm daemon 0.1.44.

---

## 1. Verdict: adopt-modified, scoped down hard

**Adopt a thin, transport-only CLI over the MCP endpoint we already have. Reject the
pack's framing.**

The pack's premise — that agensis has a "capability gap on cli" and needs agents to be
able to "list channels, read threads, post messages and manage ops" — is **already false
for agents**. `server/mcp.cjs` is a 1751-line native MCP server exposing 30 workspace
tools over authenticated stateless JSON-RPC at `POST /backend/mcp` (mounted at
`server/mcp-doors-routes.cjs:22`, also `/api/mcp` and `/mcp`). It covers every entity the
pack names and more: `list_channels` (`server/mcp.cjs:289`), `read_channel`
(`server/mcp.cjs:325`), `search_messages` (`:367`), `post_message` (`:453`),
`dispatch_agent` (`:482`), `create_channel` (`:519`), docs (`:557`–`:654`), tasks
(`:680`–`:779`), thread items (`:883`–`:960`), memory (`:989`–`:1016`), skills
(`:1084`–`:1114`), provider calls (`:1156`), agent registration (`:1206`–`:1271`), the job
loop (`:1312`–`:1360`) and `get_connect_command` (`:1391`).

More decisively: **the daemon already injects that MCP server into every coding CLI it
launches.** `leanMcpRuntime()` (`packages/agensis-cli/src/agensis.mjs:1502`) builds the
`/backend/mcp` URL plus an `AGENSIS_MCP_TOKEN` env var, and it is wired into the Claude
subprocess (`agensis.mjs:1376`, with `--strict-mcp-config`), the Codex `exec` subprocess
(`agensis.mjs:1458`), the pooled Agent-SDK lane
(`packages/agensis-cli/src/connectionExecutors.mjs:342`) and the Codex app-server lane
(`connectionExecutors.mjs:717`). Lean mode is the default. An agensis agent doing a job
today already has all 30 tools. Building a CLI so *those* agents can list channels would
be building a second front door onto a house they are already standing inside.

So the honest answer to the brief's central question is: **a CLI adds nothing for agents
that reach us over MCP. It adds four specific things, all of which are real but none of
which are "agent-first".**

1. **Operators and CI have no usable client.** An `aga_` connect token reaches exactly two
   surfaces: the daemon WebSocket and `/backend/mcp`. It does **not** reach
   `/backend/db/*` — those are gated by `requireAuth` (`server/index.cjs:506-518`), which
   requires a *user session* token, not an agent token. So "post a build result into
   #releases from a CI job" today means hand-rolling a JSON-RPC envelope with `fetch` and
   digging the payload out of `result.content[0].text`. We know this is real because we
   already wrote that client by hand: `scripts/_mcp_smoke.cjs` is 158 lines of exactly
   that, existing solely because there was no other way to drive the surface from a shell.
2. **The Amp runtime has no workspace tools at all.** `packages/agensis-cli/src/
   ampRuntime.mjs` contains zero MCP references — unlike the Claude and Codex paths, no
   MCP server is configured for an Amp-backed agent. A binary on `PATH` is the only
   mechanism that reaches a runtime with no MCP client.
3. **There is no exit-code taxonomy anywhere.** `packages/agensis-cli/bin/agensis.mjs:256-258`
   is the whole story: any error prints a message and sets exit code 1. Nothing in the
   system distinguishes "your token expired" from "that channel does not exist" from "the
   backend is down", so no shell pipeline can branch on the difference.
4. **No pagination on any read tool.** `list_channels`, `read_channel` and
   `search_messages` accept a capped `limit` only (`server/mcp.cjs:300`, `:339`, `:380` —
   caps 200/200/100). There is no offset, no cursor, no `before`. A jq-able client hits a
   hard ceiling on the third invocation. This is a **shared-surface gap**, not a CLI gap:
   fixing it in `mcp.cjs` helps every MCP client.

**Therefore: build a thin wrapper over the existing MCP route for operators, scripts and
non-MCP runtimes.** Not an "agent-first CLI". Say so in the README. The design rule that
makes it safe is that it ships **zero new server routes and zero hand-written tool
schemas** — it generates its own command surface from `tools/list` at runtime, so it
cannot drift into a second API (section 3.4). Effort: ~3 engineer-days for v1, ~2 more for
the server-side pagination and error-code work that v1 deliberately defers.

### What already exists (citations)

| Claim | Evidence |
|---|---|
| Agent-facing workspace API, 30 tools | `server/mcp.cjs:247` `buildTools()`; tool defs `:262`–`:1391` |
| Mounted, three paths, POST | `server/mcp-doors-routes.cjs:22` |
| Stateless JSON-RPC 2.0 over HTTP | `server/mcp.cjs:1626` `createMcpHandler`, `:1696` handler |
| Bearer auth, 5 identity kinds | `server/index.cjs:3027` `verifyMcpToken` → agent (`:2929`), flow `agx_` (`:3013`), workspace (`:2988`), invite (`:2966`), user login (`:3001`) |
| Single authorization chokepoint | `server/mcp.cjs:1496` `runToolForIdentity` — kinds allowlist, Flows scope, channel pin |
| Rate limit 120/min per identity | `server/index.cjs:2101`, applied `server/mcp.cjs:1711` |
| Machine-readable output already | `tools/list` returns full JSON Schema per tool (`server/mcp.cjs:1668-1675`); results are JSON in a text part (`:64`) |
| Env-var auth already | `AGENSIS_URL` / `AGENSIS_TOKEN` / `AGENSIS_WORKSPACE` / `AGENSIS_AGENT` (`packages/agensis-cli/src/connectProfiles.mjs:73-86`) |
| Credential store already | `~/.agensis/daemon-profiles/<name>.json`, mode 0600 (`connectProfiles.mjs:47`, `:116-133`) |
| MCP token already in every job subprocess env | `packages/agensis-cli/src/cli.mjs:120`; `connectionExecutors.mjs:370`, `:710` |
| Current CLI is a daemon runner only | `packages/agensis-cli/bin/agensis.mjs:16` parser, `:109` usage, `:198` main — commands are `connect`, `setup`, `supervise`, `buddy connect` |
| Public tool table already published | `server/skills.cjs:22` consumes `listToolSummaries()`; served at `/backend/skill` |

---

## 2. What the pack actually proposes

buzz ships `crates/buzz-cli` — a Rust binary whose `main.rs` is a one-liner
(`std::process::exit(run_from_args(...).await)`), with one hand-written module per entity
under `src/commands/` (agents, dms, feed, issues, moderation, notes, reactions, social,
upload, users) and a shared `client.rs`. The pack asks for the same shape in our stack:
stable subcommands for list/read/write of core entities, compact machine-readable stdout,
documented exit codes, and auth via env vars suitable for injection into an agent
subprocess.

The acceptance checks are modest: a test that drives the real entry point, no verbatim
copying, docs, and `--help` plus one happy-path command producing structured output.

### What does not transfer

- **buzz's CLI is its API client because buzz has no other one.** Its `client.rs` builds
  and signs **Nostr events** (`EventBuilder`, `Keys`, `Kind`, `Tag`) and posts them to a
  relay. Every buzz client re-implements that event construction; the CLI exists partly to
  centralise it. We have the opposite situation — one authenticated HTTP surface with
  server-side authorization and a single execution chokepoint. Our CLI has nothing to
  centralise; it can only forward.
- **The per-entity command modules are the anti-pattern for us.** Twelve hand-written
  command files, each restating an entity's fields, is exactly how a client drifts from a
  server. buzz accepts that cost because its "server" is a relay with no tool schema to
  read. We publish a full JSON Schema per tool at `tools/list`, so hand-writing the
  schemas a second time would be a deliberate choice to create drift.
- **`BlobDescriptor` / NIP-92 `imeta` media metadata (the `client.rs` excerpt) is
  irrelevant.** We have `server/files-routes.cjs` and a different upload model. Uploads are
  out of scope for v1.
- **buzz's `AGENTS.md` anchor is about its five-repo release topology.** Not transferable
  and not a CLI concern.

The pack's own `target_surface` field already concedes the point: *"agensis platform API +
optional operator CLI wrappers"*. Optional operator wrappers is the correct scope. The
`why` field ("close the capability gap on 'cli'") was generated from a repo scan that saw
no `crates/*-cli` equivalent and inferred a gap; it did not see `server/mcp.cjs`.

---

## 3. Impact on our system

### 3.1 Subsystems touched

**v1 touches the agensis repo for exactly one file — a test.** Everything else is in
`agensis-agent`. That is the point of the scoping: no routes, no DDL, no frontend.

| Subsystem | Change |
|---|---|
| `packages/agensis-cli/bin/agensis.mjs` | New branch **before** `parseArgs`, routing ops verbs to a separate parser. `parseArgs` itself untouched. |
| `packages/agensis-cli/src/ops/` (new) | The whole CLI: transport, schema-driven arg parsing, rendering, exit codes. |
| `packages/agensis-cli/src/agensis.mjs:1502` | One line: add `AGENSIS_MCP_URL` to `leanMcpRuntime`'s env so an in-job `agensis` call is zero-config. |
| `packages/agensis-cli/package.json` | `files[]` + `check` script entries for the new modules. |
| `agensis` repo, `tests/` | One new pin test on the public tool surface. |
| `server/mcp.cjs` | **Phase 2 only**: structured error codes, keyset pagination, JSON-RPC-shaped 429. |

### 3.2 What it breaks

One real hazard, and it is the biggest risk in this plan: **`bin/agensis.mjs` is the
single entry point of the published bundle.** `packages/agensis-agent/build.mjs` bundles
exactly that file (`entry = .../agensis-cli/bin/agensis.mjs`) into the one minified
artifact every daemon runs. A parse regression there breaks every install, and daemon
0.1.44 auto-updates on a 30-minute registry poll, so a bad publish propagates fast.

Two specific breakage vectors:

- `parseArgs` currently **throws on any positional argument after the command**
  (`bin/agensis.mjs:32`: `Unexpected argument: ${arg}`). Ops verbs need positionals
  (`agensis read <channel-id>`). Extending `parseArgs` in place risks changing how
  `connect`/`setup`/`supervise` parse. **Mitigation: branch before it.** A frozen
  `OPS_COMMANDS` set is tested against `argv[0]`; on a match, control goes to the ops
  parser and `parseArgs` is never called. On a miss, today's code runs byte-identically.
- A bare `agensis` with no command still means `connect` (`bin/agensis.mjs:17`). Keep that
  — changing it would break every documented invocation — but it is a footgun for a human
  who types `agensis` expecting help. Add an explicit `agensis help` and say so in usage.

Nothing else breaks. No DB, no schema, no frontend, no realtime, no wire contract.

### 3.3 Security and RBAC

The CLI **adds no server authority whatsoever**. It is a client for a route that already
exists, using a token type that already exists. Every gate applies unchanged, because
`runToolForIdentity` (`server/mcp.cjs:1496`) is the only path a tool is ever executed
through, for both the MCP door and the builtin agent turn:

- workspace scoping — the caller never supplies `workspaceId`; it comes off the verified
  token (`server/mcp.cjs:1492-1495` comment, enforced in every tool's SQL);
- the per-tool `kinds` allowlist (`server/mcp.cjs:1499-1502`);
- Flows connection scopes (`connectionCanUseTool`, `:1503`);
- the integration channel pin (`:1506-1515`);
- invite-role capability checks on write tools (`:532`, `:617`, `:728`, `:803`, `:898`,
  `:1028`, `:1252`, `:1296`), against `WORKSPACE_ROLE_CAPABILITIES` in
  `shared/backend-core.cjs:172-178`;
- the 120/min per-identity limiter (`server/index.cjs:2101`).

Read-only client tables and `DB_TABLE_ACCESS` (`shared/backend-core.cjs:187+`) are not in
play at all — the CLI never touches `/backend/db/*`, and could not: those need a user
session token (`server/index.cjs:506`).

New risks the CLI itself introduces, all client-side:

1. **Token on argv.** `--token` lands in `ps` output and shell history. The daemon gets
   away with it because `connect --token` runs once at setup; a per-invocation CLI in CI
   does not. `--token` is accepted for parity but documented as discouraged; the
   recommended order is `AGENSIS_TOKEN` → `AGENSIS_MCP_TOKEN` → profile.
2. **Token in output.** Any error dump that includes request headers leaks the bearer.
   Mandatory redaction of `/\b(aga|agx|agf|cbk)_[A-Za-z0-9_-]+/g` on every stdout and
   stderr write, tested (section 5, invariant 4).
3. **Identity confusion.** `verifyMcpToken` accepts a *user login token* and resolves it to
   the workspace that user owns (`server/index.cjs:3001-3011`). An operator who pastes
   their session token gets owner-level reach and may not realise it. Mitigation: `whoami`
   is the documented first command and prints `kind` prominently; the human renderer
   labels a non-`agent` kind explicitly.
4. **No new credential store.** Reuse `readDaemonProfile` (`connectProfiles.mjs:89`) and
   its existing 0600 files. Do not write a new config file, do not cache tokens, do not
   add a keychain.

One pre-existing observation, flagged not fixed: `post_message` (`server/mcp.cjs:453`) and
`dispatch_agent` (`:482`) carry **no invite-role capability check**, unlike the six write
tools listed above. An `invite` identity with `viewer` role (read-only per
`shared/backend-core.cjs:177`) can post, provided it names an `mcp_approved` agent via
`as:`. The CLI does not change this, but it makes the surface easier to reach. Worth a
separate one-line fix; out of scope here.

### 3.4 How it avoids becoming a second, drifting API surface

This is the design constraint everything else bends around. Three mechanisms, in order of
strength:

1. **No hand-written schemas, ever.** `agensis call <tool> --arg value` builds its flag
   parser from the tool's `inputSchema` fetched from `tools/list` at runtime
   (`server/mcp.cjs:1668-1675` already returns `{ name, description, inputSchema }`). Types
   coerce from `properties[k].type` (`string`/`integer`/`boolean`), required args come from
   `required[]`, unknown flags are rejected locally because `additionalProperties: false`.
   `call` **cannot drift**: it has no independent knowledge of any tool. A tool added to
   `buildTools()` on Fly is callable from an unchanged CLI binary the moment it deploys.
2. **The ergonomic aliases are one small table, validated at startup.** Six or so verbs
   (`channels`, `read`, `post`, `dispatch`, `tasks`, `agents`) map to `{ tool, positional[],
   flagMap }` in a single file. Before dispatching, the CLI checks each alias's tool name
   and arg names against the fetched schema; a mismatch fails with exit 2 and a message
   naming the drift, rather than sending a request the server will reject with an opaque
   error. Aliases are sugar over `call`, never a second code path.
3. **The drift alarm lives in the repo that causes drift.** A new pin test in the agensis
   repo asserts the exact public tool-name set and, for the aliased tools, their exact
   required arg names, using the real `__test.buildTools()` (`server/mcp.cjs:1750`). If
   someone renames `read_channel`, CI fails **in agensis**, where the rename happens, with
   a message saying external clients bind to these names. This has value independent of
   the CLI: `server/skills.cjs` already publishes the tool table publicly at
   `/backend/skill`, so tool names are already a public contract we have no test for.

The rule stated for the implementer: **if a CLI command needs something the MCP surface
cannot do, the fix is a new MCP tool, not a CLI-only route.** That keeps one surface with
one authorization chokepoint, and everything the CLI can do, an MCP agent can do too.

### 3.5 Interaction with work in flight

- **`self-update-supervise` (pack #12, shipped 0.1.43/0.1.44)** — no overlap, but it is
  the rollback mechanism. `runSupervisor`'s health check spawns
  `node <entry> connect --profile <name>` and rolls back on failure
  (`packages/agensis-cli/src/selfUpdate.mjs:255-256`, `:273`). So a regression in `connect`
  parsing *is* caught and rolled back — **for supervised daemons only**. A plain
  `agensis connect` under systemd/pm2 has no such guard. This is the argument for the
  don't-touch-`parseArgs` mitigation, not a substitute for it.
- **Interactive permission approvals** — untouched. The CLI drives MCP tools, not agent
  job execution; it never hits `canUseTool`.
- **Channel bridges (`server/channel-bridges.cjs`)** — untouched, but note bridges use the
  `integration` identity kind, which the CLI could authenticate as (`agx_` tokens go
  through `verifyFlowConnectionToken`, `server/index.cjs:3013`). The channel pin
  (`server/mcp.cjs:1506`) applies automatically. No work needed.
- **`thread_harvests` proposals** — has no MCP tool, so it is not reachable from the CLI.
  Correct outcome; do not add a CLI-only path to it.

---

## 4. Exact work breakdown

### 4.1 Where it lives, and why

**`agensis-agent`, `packages/agensis-cli/src/ops/`, shipped in the existing `agensis`
binary.** Reasons:

- the binary is already on `PATH` on every machine running a daemon;
- it already holds the profile store, the token, and — critically — `agentBackendUrl()`
  (`packages/agensis-cli/src/agensis.mjs:796`), which rewrites `localhost:5173` /
  `:8888` / ephemeral ports to `127.0.0.1:3142`. A CLI in the agensis repo would have to
  duplicate that or break for every local dev run;
- the npm publish lane already exists.

Rejected alternatives: a new `packages/agensis-ops` package (duplicates auth/URL logic,
adds a publish lane); a `bin` entry in the agensis repo (that repo has no `bin`, and the
frontend deploy lane cannot ship a binary).

Cost accepted: ops commands ride the daemon's release cadence, and the agensis repo cannot
run their tests. Mitigated by keeping the two halves independent — the CLI is
schema-driven, so the server can add tools without a CLI release, and the phase-2 server
changes are tested in agensis where they live.

### 4.2 Files to create (agensis-agent)

| File | Reason |
|---|---|
| `packages/agensis-cli/src/ops/exitCodes.mjs` | The taxonomy as named constants with the doc comment that defines them. One place, so `bin` and tests agree. |
| `packages/agensis-cli/src/ops/rpc.mjs` | One JSON-RPC POST: URL + token resolution, `AbortController` timeout, one retry on 429 honouring `Retry-After`, and mapping of every HTTP/RPC/tool outcome to a typed `{ ok, value } \| { ok: false, code, message }`. Injectable `fetchFn` for tests. |
| `packages/agensis-cli/src/ops/schema.mjs` | Fetch + in-process cache of `tools/list`; build a flag parser from a tool's `inputSchema`; coerce `string`→`integer`/`boolean`; reject unknown/missing args locally. |
| `packages/agensis-cli/src/ops/aliases.mjs` | The ~6 ergonomic verbs as `{ tool, positional[], flagMap }`, plus the startup validation against the fetched schema. |
| `packages/agensis-cli/src/ops/render.mjs` | JSON vs human output, TTY detection, stderr diagnostics, secret redaction, id truncation. Pure functions. |
| `packages/agensis-cli/src/ops/index.mjs` | `runOpsCommand(argv, io)` — the real entry tests drive. **Returns** an exit code; never calls `process.exit`, never writes to `process.stdout` directly (both injected via `io`). |

### 4.3 Files to modify (agensis-agent)

| File | Change |
|---|---|
| `packages/agensis-cli/bin/agensis.mjs` | Add `OPS_COMMANDS` set + a branch in `main()` **before** `parseArgs(...)` (i.e. before line 199) that calls `runOpsCommand` and `process.exit`s with its code. `parseArgs` and every existing branch stay byte-identical. |
| `packages/agensis-cli/src/agensis.mjs:1502` | `leanMcpRuntime` returns `env: { AGENSIS_MCP_TOKEN, AGENSIS_MCP_URL }`. Adds no secret (the token is already there) and makes an in-job `agensis channels` zero-config on the Claude, Codex and pooled lanes. |
| `packages/agensis-cli/package.json` | Add the six `src/ops/*.mjs` paths to `files[]` and to the `check` script's `node --check` chain. Missing this means the published bundle is fine (esbuild follows imports) but `npm run check` silently stops covering them. |
| `packages/agensis-cli/README.md` | Command reference, exit-code table, auth precedence, and an explicit "this is an operator/CI client; agents in agensis already have these tools over MCP" note. Satisfies the pack's docs acceptance check. |
| `AGENTS.md` (agensis repo) | One paragraph under the MCP section pointing at the CLI and stating the no-second-surface rule. |

### 4.4 Command surface (v1)

```
agensis whoami                         -> whoami
agensis channels [--limit N]           -> list_channels
agensis read <channel-id> [--limit N] [--thread <id>]
                                       -> read_channel
agensis post <channel-id> <text> [--thread <id>] [--broadcast] [--as <handle>]
                                       -> post_message
agensis dispatch <channel-id> <text> [--thread <id>] [--as <handle>]
                                       -> dispatch_agent
agensis tools                          -> tools/list
agensis call <tool> [--key value ...]  -> tools/call, schema-driven
agensis help [command]
```

Global flags: `--profile <name>`, `--url <url>`, `--token <t>` (discouraged), `--json`,
`--human`, `--quiet`, `--timeout-ms <n>`, `--raw`.

`tasks` and `agents` aliases are cheap to add once `call` works, but are not required for
the slice.

### 4.5 Exit-code taxonomy

Derivable in v1 with **no server change**:

| Code | Meaning | Source |
|---|---|---|
| 0 | success | tool returned, `isError` falsy |
| 1 | unexpected internal error (catch-all) | preserves today's `bin/agensis.mjs:258` behaviour |
| 2 | usage error — unknown command/flag, missing required arg, alias/schema mismatch | local, no request sent |
| 3 | auth failure | HTTP 401 (`server/mcp.cjs:1705-1707`), or no token resolvable |
| 4 | rate limited | HTTP 429 (`server/index.cjs:2216`); `Retry-After` echoed to stderr |
| 5 | tool error | JSON-RPC result with `isError: true` (`server/mcp.cjs:1689`) |
| 6 | transport failure | DNS/connect/timeout, or a non-JSON body — including the common "you pointed at `agensis.io` and got the SPA's HTML" case, which must produce a named error suggesting the backend URL, not a JSON parse crash |
| 7 | protocol error | a JSON-RPC `error` object (`-32601` unknown method, `-32600` invalid request) |

**Honest limitation, stated up front:** code 5 is a single bucket. The server returns tool
failures as `{ isError: true, content: [{ type: 'text', text: message }] }`
(`server/mcp.cjs:67`, `:1689`) with **no machine-readable code**, so the CLI cannot
distinguish "channel not found" from "forbidden" from "bad argument" without inventing
string matching on English error text. It will not do that. Phase 2 fixes it at the
source (4.7).

### 4.6 `--json` vs human output

- **Default is TTY-dependent**: human when `stdout.isTTY`, JSON when it is not. A
  subprocess or a pipe gets machine output with no flag — the one genuinely "agent-first"
  behaviour worth keeping from the pack. `--json` / `--human` force either.
- **JSON mode invariant**: stdout carries **exactly one JSON document and nothing else**.
  Every warning, note, progress line and error goes to stderr. This is what makes `| jq`
  safe, and it is invariant 3 in the test plan.
- **The JSON body is the tool's own result object**, unwrapped from the MCP
  `content[0].text` envelope. No CLI-invented wrapper, no renamed fields, no added
  metadata — again, no second API. `--raw` emits the complete JSON-RPC response for
  debugging the transport.
- **Errors in JSON mode**: stdout stays empty; stderr gets
  `{"error":{"code":"tool_error","message":"..."}}`. Callers branch on the exit code first.
- **Human mode**: aligned columns, ids truncated to 8 chars (`--full-ids` disables),
  timestamps as `YYYY-MM-DD HH:mm`, no colour unless `stdout.isTTY && !process.env.NO_COLOR`.

### 4.7 Pagination

**v1**: pass `limit` through; when `rows.length === limit`, write one line to stderr —
`note: hit limit N; results may be truncated` — and leave the exit code at 0. Honest, and
zero server work.

**Phase 2 (server, additive, `server/mcp.cjs`)**: keyset pagination, not offset. Offset
over a live `messages` table skips and duplicates rows as new messages land.

- `read_channel`: add optional `before` (ISO-8601 timestamp or message id); the query
  already orders `created_at desc` (`server/mcp.cjs:348`, `:359`), so this is one extra
  `and created_at < $n` clause. Return `next_before` (the oldest returned row's
  `created_at`), or `null` when the page was short.
- `search_messages`: same treatment on `m.created_at` (`server/mcp.cjs:395`).
- `list_channels`: optional `before` on `updated_at` (`server/mcp.cjs:316`).

All three are new optional properties on schemas that are `additionalProperties: false`;
existing callers are unaffected and every MCP client gains the capability. The CLI then
grows `--all`, looping until `next_before` is null, with a hard `--max` cap (default 5000)
so a runaway loop cannot burn the 120/min limiter.

### 4.8 Also phase 2: structured tool errors and a JSON-RPC 429

Two small `server/mcp.cjs` changes that make the exit-code taxonomy actually useful:

```js
// server/mcp.cjs — ToolError gains a machine code; every existing
// `new ToolError('...')` keeps working via the default.
class ToolError extends Error {
  constructor(message, code = 'tool_error') { super(message); this.code = code; }
}
// toolError() renders it in _meta, a legal MCP result field that clients
// which do not read it simply ignore.
function toolError(message, code) {
  return { content: [{ type: 'text', text: String(message) }], isError: true, _meta: { code } };
}
```

Then annotate the handful of throw sites that matter: `not_found` (channel/agent/task
lookups), `forbidden` (the `kinds` and invite-role refusals at `:1500`, `:532` etc.),
`invalid_argument` (`requireString`, `server/mcp.cjs:73`). The CLI then extends the table
upward rather than renumbering: `8 = not found`, `9 = forbidden`, with
`invalid_argument` routed to the existing `2` (usage). v1's codes 0–7 are chosen so that
nothing has to be renumbered when this lands, and a script written against v1 keeps
working — it just stops seeing everything as `5`.

Second: the 429 path currently returns `{ data: null, error: { message, code } }`
(`server/index.cjs:2216` via `rateLimitBlocked`, called at `server/mcp.cjs:1711`) — a
non-JSON-RPC body on a JSON-RPC endpoint. Give `createMcpHandler` its own responder that
writes `jsonrpcError(id, -32000, 'Rate limit exceeded')` with the `Retry-After` header
preserved. Contained entirely in `mcp.cjs`.

**No DDL. No `ensureRuntimeSchema()` work. No new tables or columns in any phase of this
plan.**

### 4.9 Build sequence

A genuine vertical slice first — step 1 alone proves auth resolution, transport, exit
codes and JSON discipline end to end.

1. **`agensis whoami --json` working against a live workspace.** `exitCodes.mjs` +
   `rpc.mjs` + minimal `render.mjs` + `index.mjs` + the `bin` branch + one test. (~0.5d)
2. **`agensis tools` and `agensis call <tool> --k v`** — `schema.mjs`. This is the entire
   tool surface in one command; everything after it is ergonomics. (~0.75d)
3. **Aliases** — `channels`, `read`, `post`, `dispatch` + startup schema validation. (~0.5d)
4. **Human rendering, TTY default, redaction, `--raw`, `help`.** (~0.5d)
5. **Docs, `AGENSIS_MCP_URL`, `package.json` plumbing, the agensis-repo pin test.** (~0.5d)
6. *(Phase 2, separate)* server error codes + keyset pagination + `--all`. (~2d)

---

## 5. Test plan

**The globs, exactly.** They differ between the two repos and a file in the wrong place
runs in neither:

- **agensis-agent**, node:test — `"test": "node --experimental-test-module-mocks --test
  tests/*.test.cjs tests/*.test.mjs"`. Both extensions, **repo `tests/` root only**, not
  nested.
- **agensis-agent**, vitest — `"test:unit": "vitest run tests/unit"`. No `vitest.config`
  in that repo, so vitest defaults apply, filtered to `tests/unit/`. Existing files there
  are `.test.ts`. Keep to `.test.ts` under `tests/unit/` so there is no ambiguity about
  which runner owns a file.
- **agensis**, node:test — `"test": "node --require ./tests/helpers/test-env.cjs
  --experimental-test-module-mocks --test tests/*.test.cjs"`. **`.cjs` only** — a
  `tests/*.test.mjs` in this repo is run by nothing. (This differs from agensis-agent; the
  brief's "`tests/*.test.cjs|mjs`" is right for the agent repo and wrong for this one.)
- **agensis**, vitest — `tests/unit/**/*.test.ts` only (`vitest.config.ts`).

### Files

| File | Runner | Contents |
|---|---|---|
| `agensis-agent/tests/agensis-ops-cli.test.mjs` | node:test | Drives the real `runOpsCommand(argv, io)` with an injected `fetchFn` and captured stdout/stderr. Invariants 1–4, 6, 7. |
| `agensis-agent/tests/unit/opsRender.test.ts` | vitest | Pure functions: redaction, id truncation, type coercion, TTY default selection. |
| `agensis-agent/tests/agensis-cli-args.test.mjs` *(or extend an existing arg test)* | node:test | Invariant 5 — the existing daemon commands still parse identically. |
| `agensis/tests/mcp-public-surface.test.cjs` | node:test | The drift alarm. Uses the real `require('../server/mcp.cjs').__test.buildTools()`. |
| `agensis/tests/mcp.test.cjs` (extend) | node:test | Phase 2 only: `_meta.code` on tool errors; keyset `before` on the three read tools. 75 tests and a fake DB already live here. |

### Invariants worth pinning, and the mutation that must break each

1. **A tool error exits 5 and prints nothing to stdout.** Stub `fetchFn` to return
   `{ result: { isError: true, content: [{ type:'text', text:'nope' }] } }`.
   *Mutation that must fail the test:* return 0 when `isError` is set, or write the error
   text to stdout.
2. **HTTP 401 exits 3, stdout empty, stderr mentions the token source that was used**
   (env name or profile path — never the token).
   *Mutation:* treat a non-2xx as a transport error (6), or fall through to 1.
3. **In JSON mode stdout parses as exactly one JSON document.** Run a command whose stub
   response also triggers the truncation warning; assert `JSON.parse(stdout)` succeeds and
   the warning is present in stderr.
   *Mutation:* emit the warning (or any progress line) on stdout — `JSON.parse` throws.
4. **No token appears in any output on any path.** Run the failure paths for 401, 429,
   transport error and `--raw` with a token of `aga_TESTSECRET`; assert neither stream
   contains it.
   *Mutation:* include request headers in the `--raw` dump, or interpolate the token into
   an error message.
5. **The daemon commands are unchanged.** Assert `parseArgs(['connect','--url','u',
   '--token','t','--workspace','w','--agent','a'])` yields the identical object it does
   today, and that `agensis` with no args still resolves to `connect`.
   *Mutation:* consume the first positional in the shared path, or add an ops verb that
   collides with `connect`/`setup`/`supervise`/`buddy`.
6. **An unknown flag fails locally with exit 2 and sends no request.** Assert the injected
   `fetchFn` was never called.
   *Mutation:* forward unknown args to the server — `fetchFn` gets called, test fails.
7. **A non-JSON response body is a named transport error (6), not a crash.** Stub an HTML
   body (the "wrong URL" case).
   *Mutation:* `await res.json()` unguarded — throws, lands in the catch-all 1, test fails.
8. **The public tool surface is pinned** (agensis repo). Assert the exact set of tool names
   from `buildTools()`, and that `read_channel` requires `channel_id`, `post_message`
   requires `channel_id`+`content`, `dispatch_agent` requires `channel_id`+`content`.
   *Mutation:* rename any tool or required arg — fails in the repo that made the change,
   with a message explaining that external clients bind to these names.

### On mock vacuity

The known trap in this repo is a mock that restates the logic under test (a fake DB
enforcing the WHERE clause tests the fake). It applies differently here:

- The agensis-agent tests mock **`fetch`**, not the DB, and assert on **exit codes and
  stream discipline** — behaviour the stub does not contain. A stub that returns a canned
  MCP response cannot itself decide that `isError` maps to 5.
- Invariant 6's assertion is specifically *that the stub was never called* — the strongest
  form, since a vacuous stub cannot fake absence.
- Invariant 8 uses **no mock at all**: real `buildTools()`, real schemas.

The one place to be careful: do not write a test whose stub response is constructed from
the same alias table the code reads. Assert against literal expected JSON.

---

## 6. Migration and rollout

**Data migration: none.** No tables, no columns, no backfill, in any phase. Nothing to
reverse.

### Deploy lanes

| Phase | Lane | Why |
|---|---|---|
| v1 (all of it) | **npm publish of `@agensis/agensis-agent`** | The CLI ships in the bundle built by `packages/agensis-agent/build.mjs` from `bin/agensis.mjs`. |
| v1 | **local daemon restart** (this machine only) | To use the new verbs from the checkout before publishing. |
| v1 | Netlify — **not needed** | No frontend change. |
| v1 | `fly deploy` — **not needed** | No server change. The one agensis-repo file is a test. |
| Phase 2 | **`fly deploy`** | `server/mcp.cjs` error codes + pagination + the 429 shape. |
| Phase 2 | Netlify — **not needed** | `/backend/mcp` is **not mounted** in `netlify/functions/backend.mjs` (grep: zero matches). The MCP surface is Fly-only. |

Two consequences of that last row worth writing into the README:

- The CLI must point at the **Fly backend** (`https://agensis-backend.fly.dev`), not
  `agensis.io`. The frontend's own CSP `connect-src` confirms that split
  (`netlify.toml:170`). Pointing at `agensis.io/backend/mcp` returns the SPA's HTML —
  hence invariant 7's named error rather than a parse crash.
- Reusing the saved profile makes this automatic: connect commands are generated with
  `requestBaseUrl()` (`server/index.cjs:2797`) on the Fly host, so profiles already hold
  the correct base URL. Hand-typing `--url` is the failure mode.

### Version bump

`packages/agensis-agent/build.mjs` stamps the published version over a `SOURCE_VERSION`
token and **throws unless it appears exactly once**. So bumping needs both
`packages/agensis-cli/package.json` `version` and `build.mjs`'s `SOURCE_VERSION` — the
existing `npm run version:check` covers this; run `npm run verify` before publishing.

### Feature flag and rollback

No server flag is needed — v1 adds no server behaviour. The client-side flag is the
`OPS_COMMANDS` set: emptying it reverts the binary to today's behaviour in one line.

Rollback concretely:

- **Ops commands broken** — low blast radius: the daemon does not call them. Publish a
  patch, or the operator pins the previous version.
- **`connect` parsing broken** — high blast radius, and the reason for the
  don't-touch-`parseArgs` design. For **supervised** daemons, `selfUpdate.mjs` catches it:
  install → flip `current` → spawn → health-check → on failure flip `current` back and
  respawn the previous version (`selfUpdate.mjs:255-256`, `:273`). For daemons run as a
  plain `agensis connect` under systemd/pm2, there is **no** automatic rollback; recovery
  is `npm i -g @agensis/agensis-agent@<previous>`. Staged rollout: publish, verify on this
  machine's supervised daemon, wait one poll interval (30 min) before announcing.
- **Phase 2 server change** — additive optional args and an extra `_meta` field; rolling
  back is a `fly deploy` of the previous image, and older CLIs are unaffected either way.

---

## 7. Risk register and effort

Ranked. The first two are the ones that can actually hurt.

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **A parser regression in `bin/agensis.mjs` breaks `connect` for every daemon**, and 0.1.44's 30-minute auto-update poll propagates it fast. | High — availability, not data | Branch **before** `parseArgs`; never modify it. Invariant 5 pins the existing parse. Verify on a supervised daemon before announcing; `selfUpdate` health-check + rollback is the safety net for supervised installs only. |
| 2 | **Token leakage** via `ps`/shell history (`--token`) or an error dump. | High — security | Env + profile are the documented path; `--token` documented as discouraged. Mandatory redaction regex on every write, pinned by invariant 4. Never persist a token. |
| 3 | **The CLI grows a hand-written surface that drifts from MCP.** | Medium — correctness, slow-acting | Schema-driven `call` cannot drift; the alias table is validated at startup; the pin test fails in the repo that renames a tool (invariant 8). Written rule: new capability = new MCP tool, never a CLI-only route. |
| 4 | **Identity confusion** — an operator uses their user login token and acts with owner reach. | Medium — security | `whoami` documented as the first command; the human renderer labels non-`agent` kinds. No new authority is granted; this is a UX guard on an existing behaviour. |
| 5 | **`--all` pagination loop hammers the 120/min limiter** and gets the agent's whole identity rate-limited, including its real job traffic. | Medium — availability | Phase 2 only. Hard `--max` cap, single retry honouring `Retry-After`, exit 4 rather than spinning. |
| 6 | **The bundle grows for every daemon** even though most never run an ops command. | Low | Six small modules; dynamic-import the ops tree from `bin` (esbuild inlines it with `splitting: false`, as it already does for `supervise.mjs` at `bin/agensis.mjs:224`). Measure the artifact before/after. |
| 7 | Two repos, one feature — the agensis repo cannot run the CLI's tests. | Low — process | The two halves are independent by design; the only cross-repo contract is the tool-name set, and invariant 8 pins it on the agensis side. |

**No risk in this plan can cause data loss.** There is no DDL, no migration, no delete
path, and no write the MCP surface does not already expose to the same tokens.

### Effort

- **v1: 3 engineer-days.** Confidence: **medium-high**. The transport is ~120 lines against
  an endpoint whose exact contract is already exercised by `scripts/_mcp_smoke.cjs`, and
  the auth/URL resolution is reuse, not new code.
- **Phase 2: 2 engineer-days.** Confidence: **medium** — keyset pagination touches three
  live SQL queries in `server/mcp.cjs`, and `tests/mcp.test.cjs`'s fake DB will need its
  query matching extended to cover the new clauses.

**Biggest unknown:** how cleanly the ops branch can be bolted into `bin/agensis.mjs`
without disturbing a file that is the entry point for every installed daemon. The design
(branch before `parseArgs`) makes it look like a 10-line change, but it needs to be
verified against a real supervised daemon restart, not just a unit test, before publish.

### Deliberately NOT in v1

- **Any new server route.** The CLI is a client for `/backend/mcp` and nothing else.
- **Any DB table or column.**
- **`--wait` on `dispatch`.** `dispatch_agent` returns immediately and replies arrive
  asynchronously (`server/mcp.cjs:506-514`). Waiting means either polling `read_channel`
  or opening the realtime WebSocket, both of which deserve their own design.
- **Ops-in-the-operational-sense commands** — daemon connection liveness, pending
  permission requests, schedules, bridges. None has an MCP tool today, and adding them as
  CLI-only routes is exactly the second-API failure mode this plan exists to prevent. If
  wanted, add MCP tools first.
- **Upload / attachments** (the pack's `BlobDescriptor` anchor).
- **Shell completions, a config file, colour themes, an interactive TUI.**
- **Wiring Amp to MCP** (`ampRuntime.mjs` has no MCP config). Real gap, separate change —
  and a CLI on `PATH` is a partial workaround for it in the meantime.
- **Reactions, emoji, moderation, notes, feed** — buzz command modules with no agensis
  equivalent.

### What I could not determine

- Whether Amp supports an MCP server configuration at all. If it does, wiring
  `leanMcpRuntime` into `ampRuntime.mjs` may be a better fix than a CLI for reason #2 in
  the verdict — it would need one person to check Amp's CLI flags.
- The exact published-bundle size delta; `npm run build` was not run (the brief forbids
  builds). Risk 6 assumes it is small based on the module count, not measurement.
