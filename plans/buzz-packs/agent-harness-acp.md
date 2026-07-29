# buzz pack 01 — Agent harness (ACP bridge)

- **Concept id**: `agent-harness-acp` (rank 1, priority 97)
- **Source pack**: `/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/agent-harness-acp/`
- **buzz reference**: `/Users/jkneen/Documents/GitHub/buzz/crates/buzz-acp/` (read for behaviour; nothing copied)
- **Stated target surface**: agensis `server/agent-jobs.cjs` / `agents-routes` + desktop agent UX
- **Written**: 2026-07-29, against `main-next` @ `78fe79f`, Fly v126, daemon 0.1.44

---

## 1. Verdict

**Adopt-modified, and much narrower than the pack asks for.**

The pack's headline — "bridge workspace mentions/events to AI coding agents via a
structured protocol, with pool lifecycle, queueing and observer modes" — describes a
system agensis already has, end to end and in production. Mentions already become jobs,
jobs already queue per conversation, output already streams as deltas/segments/steps, a
warm subprocess connection is already reused across turns, and one of our three runtimes
(codex app-server) is *already* JSON-RPC-over-NDJSON-over-stdio — the exact transport
buzz's `acp.rs` describes. Building "an ACP bridge" as specified would rebuild what
`packages/agensis-cli/src/connectionExecutors.mjs` and `server/agent-jobs.cjs` do.

So the recommendation is not "build the harness". It is: **take the four things buzz's
harness genuinely has that ours does not, build those three of them that are worth it,
and reject ACP as a protocol adoption.**

Recommended for v1 (about 5 engineer-days total):

| # | Item | Status here today | Verdict |
|---|---|---|---|
| A | **Structured stop reasons** | The Claude SDK already sends us `stop_reason`, `terminal_reason`, `permission_denials`, `usage` and `total_cost_usd` on every result — and `connectionExecutors.mjs:394-403` reads only `subtype` and throws the rest away. Everything downstream sees a single opaque `error` string. | **Adopt.** Highest value/cost ratio in the pack. Not new protocol work — we are discarding data already on the wire. |
| B | **Idle deadline separate from hard deadline** | The daemon has ONE flat timeout (`DEFAULT_TIMEOUT_MS`, 30 min, `agensis.mjs:42`). The server separately reaps on 10 minutes of content-silence (`agent-jobs.cjs:303-323`). These are two different clocks in two different processes that do not know about each other, and the daemon's is the only one that can actually stop the work. | **Adopt.** |
| C | **A real worker pool** | We do **not** have one, despite appearances — see the finding below. | **Adopt, behind a flag.** |
| D | **Observer / raw-protocol trace** | Absent. | **Defer.** High leak surface, low product value now. See §7. |
| — | **ACP as a protocol** | We run three runtimes behind (mostly) one executor seam. | **Reject as a replacement; allow later as one more family.** See §2.3. |

### 1.1 The one finding that justifies item C

**`--max-concurrency 2` is a no-op on the default code path.**

- `packages/agensis-cli/src/agensis.mjs:296-304` builds the lane queue with
  `concurrency: config.maxConcurrency` (default 2, `agensis.mjs:47`), so two
  conversations can be in flight at once.
- `agensis.mjs:1110` sets `sessionKey: ${job.workspaceId}:${config.agent}` — **the lane
  is not part of the key.**
- `connectionExecutors.mjs:497` wraps every run in `withLock(opts.sessionKey)`, and
  `createKeyedMutex` (`connectionExecutors.mjs:68-76`) chains same-key calls onto one
  promise tail.
- `fastConnection` defaults to **true** (`agensis.mjs:745`).

Net effect on a default daemon: the queue admits two lanes, then the mutex serialises
them onto a single warm session. Effective parallelism is 1. The only path that actually
runs two jobs at once is the *fallback* `LocalExecutor` (`executor.mjs:12-14`, no mutex),
i.e. the slower path we take when the SDK is missing. This is not a bug in either file —
the mutex comment is correct that concurrent jobs must not race one connection — it is
the absence of the thing buzz's `pool.rs` is: N connections with claim/return, so
"don't race a connection" and "run two conversations" stop being in conflict.

**Second-order consequence, worth knowing before touching this:** because one session
serves the whole silo, consecutive turns in *different* conversations share one Claude
conversation history. Turn N in `#build` is visible to turn N+1 in a DM. Within one
workspace and one agent that is not a privilege escalation, but it is cross-channel
context bleed that nobody chose. Slot-per-lane fixes it as a side effect — which also
makes it a **behaviour change**, hence the flag in §4.3.

### 1.2 What already exists (do not rebuild)

Ingress, lifecycle and streaming, with citations:

- **Mention/event to job**: `server/task-dispatch.cjs` (task + comment `@mention`
  dispatch), the channel-mention path in `server/index.cjs`, `server/builtin-turn.cjs`.
  Jobs are inserted by `server/agent-jobs.cjs` and `server/builtin-turn.cjs` only.
- **Job row + one-active-job invariant**: `agent_jobs` DDL at `server/index.cjs:1078-1098`;
  `insertActiveAgentJob` tolerating the partial unique index at `agent-jobs.cjs:66-81`.
- **Per-conversation queue with cancel and dedupe**: `packages/agensis-cli/src/queue.mjs:77-199`
  — lanes, `enqueue`/`cancel`/`cancelActive`, dedupe by key, idle drain.
  `laneKeyForJob` at `agensis.mjs:829`. This is buzz's `queue.rs` in miniature.
- **Warm connection reuse**: `createClaudeSdkExecutor` (`connectionExecutors.mjs:284-569`)
  keeps one streaming-input SDK query alive across turns with a session-lifetime pump
  (`:381-493`) and idle self-close (`:303-309`).
- **JSON-RPC/NDJSON over child stdio**: `createJsonRpcClient` at
  `connectionExecutors.mjs:572-628`, driving `initialize` → `thread/start` →
  `turn/start` → `turn/interrupt` (`:714-726`, `:813`, `:834`). Structurally identical
  to buzz's `initialize` → `session/new` → `session/prompt` → `session/cancel`.
- **Streamed partial output**: `agent_job_delta` / `agent_job_step` / `agent_job_segment`
  frames (`agensis.mjs:1039-1074`), routed at `server/realtime.cjs:494-506` and
  persisted by `handleAgentJobDelta` / `handleAgentJobStep` (`agent-jobs.cjs:955-1062`) /
  `handleAgentJobSegment` (`agent-jobs.cjs:1073+`).
- **Liveness and reaping**: `isAgentJobLive` (`agent-jobs.cjs:87-101`),
  `hasActiveBurstJob` (`:133-153`), `finalizeStuckJob` (`:198-248`),
  `reapStuckAgentJobs` (`:303-323`), `rehomeRunningJobs` (`:259-272`),
  `JOB_RECONNECT_GRACE_MS = 45_000` (`agent-connections.cjs:283`).
- **Human-in-the-loop permissions**: `server/agent-permissions.cjs` +
  `packages/agensis-cli/src/permissions.mjs` + `makeCanUseTool`
  (`connectionExecutors.mjs:242-279`). buzz **auto-approves every permission request**
  with `allow_once` (`buzz/crates/buzz-acp/src/acp.rs:1162`, `:1865-1925`). We are
  strictly ahead here, and any ACP work must not regress it — see §2.3.

---

## 2. What the pack actually proposes

### 2.1 The concept in our terms

buzz's `buzz-acp` crate is a **harness process** that sits between a Nostr relay and one
or more AI coding-agent subprocesses. Reading the four anchors:

- **`acp.rs`** — an ACP client owning one agent subprocess, talking JSON-RPC 2.0 as
  newline-delimited JSON over stdio, with a bounded line codec (10 MB cap, to stop a
  rogue agent OOMing the harness). Lifecycle: `spawn` → `initialize` (negotiates
  `protocolVersion: 2`, `acp.rs:128-137`) → `session/new` (carrying MCP server config)
  → `session/prompt` with **both** an idle timeout and a hard deadline, returning a
  **`StopReason`** → `session/cancel` or `cancel_with_cleanup`.
  - `StopReason` (`acp.rs:46-79`): `end_turn`, `cancelled`, `max_tokens`,
    `max_turn_requests`, `refusal`, parsed case-insensitively, unknown values rejected.
  - `AcpError` (`acp.rs:81-113`) distinguishes `IdleTimeout`, `HardTimeout`,
    `CancelDrainTimeout`, `Timeout`, `WriteTimeout`, `AgentExited`, `Protocol`,
    `AgentError{code}`.
  - `cancel_with_cleanup` (`acp.rs:922-1010`) answers any in-flight permission request
    with `cancelled`, sends `session/cancel`, then *keeps reading* until the prompt
    response lands — inheriting the original hard deadline (with a 30 s floor) so
    cancelling does not start a fresh timer.
- **`pool.rs`** — N owned clients in slots; `try_claim()` moves a client out, the task
  returns it via a channel, `return_agent()` puts it back. A task map exists purely for
  panic recovery. `pool_lifecycle.rs` adds lazy wake with exponential backoff
  (5 s doubling to 300 s) and rejects stale wake results.
- **`queue.rs`** — per-channel event queues with per-channel in-flight tracking; the
  oldest-pending channel is flushed by draining **all** its events into one batch.
  Caps: 500 pending per channel, 50 events per batch, 10 retries with 5 s→300 s
  backoff, then dead-letter. Two dedup modes: **Drop** (new events for an in-flight
  channel are discarded) and **Queue** (accumulate and batch next cycle).
- **`observer.rs`** — an in-process broadcast bus with a 1000-event ring buffer, carrying
  raw ACP wire activity tagged with `{seq, timestamp, kind, agentIndex, channelId,
  sessionId, turnId, startedAt, payload}`. Deliberately process-local with no HTTP port;
  `lib.rs:411-520` pages it out to the relay **encrypted and owner-scoped**, with a
  pacer and a chunk coalescer.

### 2.2 Where buzz's assumptions do not transfer

| buzz assumption | agensis reality |
|---|---|
| Rust + tokio; ownership moves make "claim an agent out of a slot" free and safe. | Node. Our equivalent of `OwnedAgent` is a `Map` entry plus discipline; a slot leak is a live-lock, not a compile error. Release must be in a `finally`. |
| The relay is the single source of truth; every action is a signed Nostr event with a `kind` integer. | Postgres is the source of truth; the WS layer is a fanout, not a log. `notifyDbSubscribers` broadcasts *rows*. There is no event log to replay a harness from. |
| The harness is one long-lived process the operator runs, holding both queue and pool. | Split across two repos and three processes: the Fly server owns the job row and the reapers, the daemon owns the queue and the subprocess, the browser owns rendering. Every buzz in-process invariant becomes a wire contract for us. |
| Channel-level batching: N events for one channel collapse into one prompt. | Our unit is a **job**, created server-side, one per trigger, with a DB uniqueness invariant behind it (`insertActiveAgentJob`). Batching would have to happen server-side before job creation, and would fight `hasActiveBurstJob`. |
| No human-in-the-loop permissions (auto-`allow_once`). | We have a full approval broker with RBAC and persisted rules. |
| `agent_index` is a stable slot number the operator can reason about. | Our agents are workspace rows with UUIDs; a slot number is an internal detail that must not leak into the product. |

### 2.3 The ACP question, answered directly

**Would ACP replace our executor abstraction, sit under it, or duplicate it?**

It would **sit under it**, as a fourth family — and it is not worth doing in v1.

The seam already exists: `createExecutor(job, { family })` at `executor.mjs:87-95`
returns something with `run(opts) -> {status, stdout, stderr, error}` plus an `onData`
callback. `createPrimaryExecutor` (`executor.mjs:38-58`) picks the pooled Claude SDK or
codex app-server executor and falls back to `LocalExecutor` when a family proves absent.
Adding ACP means writing `createAcpExecutor` next to the other two and returning it for
`family === 'acp'`. That is genuinely cheap — perhaps 1.5 days on top of item A, since
`createJsonRpcClient` is already the right transport client.

What it would buy: any agent shipping an ACP adapter (goose, gemini, others) becomes a
runtime we support for the cost of a command name. `server/lib/capabilities.cjs:233-234`
**already probes** for `@agentclientprotocol/claude-agent-acp` and
`@agentclientprotocol/sdk` and reports them in `/system/capabilities` — and nothing in
the codebase consumes that signal. So the detection half is built and idle.

What it must **not** do is become the interface for the Claude lane, for three concrete
reasons:

1. **It would break persisted permission rules.** ACP's `session/request_permission`
   carries `options: [{optionId, name, kind}]` where `kind` is one of
   `allow_once | allow_always | reject_once | reject_always`
   (`buzz/crates/buzz-acp/src/acp.rs:2281-2300`). An `optionId` is opaque and
   session-scoped. Our "always allow" is built on the Claude SDK handing us **its own
   rule suggestions**, stored verbatim and compared byte-identically later
   (`AGENTS.md:60-66`, `isAllowedByStoredRules` via `connectionExecutors.mjs:256`).
   There is no ACP field that survives a process restart the way a rule string does.
2. **It would lose per-turn fidelity we depend on.** The SDK's typed `SDKMessage` stream
   is what gives us thinking blocks, `tool_use`/`tool_result` pairing, and
   assistant-block segmentation (`connectionExecutors.mjs:404-473`). Going through a
   generic protocol adapter means whatever that adapter chooses to surface.
3. **It would lose data we are about to start using.** See item A: the SDK result carries
   `stop_reason`, `terminal_reason`, `permission_denials`, `usage`, `total_cost_usd`.

**Honest correction to the pack's framing.** The recommendation says the matrix dimension
"Agents as first-class peers" favours buzz. On the *harness* axis that is not what the
code shows: buzz has a better pool and better stop-reason typing; agensis has real
permission brokering, DB-durable job liveness, thread-aware streaming, three runtimes,
and a reconnect story. The gap is narrower and more specific than "close the capability
gap on agent-runtime" implies.

Also worth correcting: the pack lists "observer/read-only mode" as an interface to
preserve. There is **no read-only agent mode in buzz**. `observer.rs` is a wire-level
telemetry bus for the desktop app. Nothing in `config.rs` or `lib.rs` matches
`read_only`, `passive`, or `observe_only`. Do not build a "read-only agent" on the
strength of that phrase.

---

## 3. Impact on our system

### 3.1 Subsystems touched

| Subsystem | Change | Risk |
|---|---|---|
| `packages/agensis-cli/src/connectionExecutors.mjs` | Read the SDK's terminal fields; add slot-aware session keys; add an idle watchdog per turn. | Medium — this file is the hot path for every daemon turn. |
| `packages/agensis-cli/src/executor.mjs` | Pass a `stop` object through the result shape alongside `{status,stdout,stderr,error}`. | Low, additive. |
| `packages/agensis-cli/src/agensis.mjs` | Emit `stopReason` on `agent_job_result`; allocate a slot per lane; pass `idleTimeoutMs`. | Medium. |
| `server/agent-jobs.cjs` | Validate a daemon-supplied stop reason against a closed enum; persist into `agent_jobs.metadata`; use it in the placeholder text. | Medium — `finalizeAgentJobResult` is shared by the daemon and MCP paths. |
| `server/realtime.cjs` | No change. The stop reason rides the existing `agent_job_result` frame. | None. |
| `src/types/index.ts`, chat transcript | Render a typed stop reason instead of a raw error string. | Low. |
| `shared/backend-core.cjs` | No change. No new table, no new allowlist entry. | None. |

### 3.2 What it would break or force

- **Nothing requires a migration.** Every new server-side field lands in
  `agent_jobs.metadata` (jsonb, `server/index.cjs:1090`) — the same no-DDL route
  `metadata.host_folders` and `metadata.sandbox_skills` took. The three-place schema
  rule in `AGENTS.md:23-38` therefore does not apply to items A and B. Item C is
  daemon-only and touches no schema at all.
- **The pool (item C) changes conversational behaviour.** Today one session serves every
  conversation for a silo; after the change each lane gets its own slot where slots
  allow. An agent will stop "remembering" what it said in another channel. This is the
  right behaviour and also a visible change, so it ships behind
  `AGENSIS_SESSION_SLOTS` defaulting to 1 (today's behaviour) for one release.
- **Wire compatibility is two-way.** An old daemon sends no `stopReason` and the server
  must behave exactly as today; a new daemon against an old Fly must not break. Both
  directions need a test (§5).
- **Interaction with in-flight work.** `self-update-supervise` (pack 12) already shipped
  in 0.1.43/0.1.44 with an idle guard so an update never lands mid-turn
  (`packages/agensis-cli/src/selfUpdate.mjs`, `supervise.mjs`). Item C changes what "idle"
  means for a silo — with N slots, "idle" is *all* slots free, not the single session
  closed. **That guard must be updated in the same PR as item C**, or a self-update can
  land while slot 2 is mid-turn. This is the single most likely way this pack breaks
  something already working.
- **Permission requests must survive a slot.** The reconnect-surviving permission work
  that shipped today parks a request against the live socket, not the session. Slots do
  not change that, but `makeCanUseTool` closes over `session.activeTurn`
  (`connectionExecutors.mjs:243`) — with N sessions there are N `activeTurn`s, and the
  request must route to the right one. Covered in §4.3.

### 3.3 Security and permissions

- **A stop reason is untrusted daemon input.** It arrives on a websocket frame from
  someone else's machine. It must be validated against a closed enum before it is
  persisted or rendered, exactly the way `ampResultMetadata` validates Amp fields against
  `AMP_THREAD_ID_RE` / `AMP_ERROR_CODE_RE` (`agent-jobs.cjs:329-348`). An unrecognised
  value is dropped, not stored and not echoed. It is rendered into chat, so an
  unvalidated string is a content-injection vector into a human's transcript.
- **No new route, so no new RBAC surface.** Items A–C add zero HTTP endpoints. Everything
  rides `agent_job_result`, already authenticated by `ws.agentAuth` and scoped by the
  `(jobId, agentId, workspaceId)` lookup at `agent-jobs.cjs:1078-1085`. The existing
  `write`/`manage` split is untouched.
- **`usage` / `total_cost_usd` are the one field group that needs a decision.** The SDK
  gives us per-turn cost. Storing it in `agent_jobs.metadata` is fine (server-side, not
  in an allowlisted client table). Broadcasting it is not obviously fine —
  `sanitizeRealtimeRow` (`AGENTS.md:39-46`) exists to keep heavy/sensitive fields out of
  fanout. **v1 stores cost and does not broadcast or render it.**
- **The observer (item D) is the reason it is deferred.** A raw JSON-RPC trace contains
  prompts, file contents, tool arguments and whatever the agent read. buzz encrypts its
  frames owner-scoped before they touch the relay (`buzz/crates/buzz-acp/src/lib.rs:411-520`).
  Any agensis version would need: opt-in per agent, `manage`-only read, explicit
  exclusion from `sanitizeRealtimeRow`, a hard size cap, and a retention window. That is
  a security-review-sized piece of work for a debugging feature.

---

## 4. Work breakdown

### 4.0 Ordering

The vertical slice is **item A**: one field, daemon → wire → server → DB → transcript,
shippable alone and useful alone. B depends on A only for its reporting vocabulary. C
depends on B (a pool without per-turn deadlines multiplies stuck turns by N).

```
A. Stop reasons (1.0 d)  →  B. Idle vs hard deadline (1.5 d)  →  C. Session pool (2.5 d)
```

### 4.1 Item A — structured stop reasons

**Daemon (`agensis-agent` repo)**

| File | Change |
|---|---|
| `packages/agensis-cli/src/stopReasons.mjs` *(new)* | The closed vocabulary and the two mappers. Pure, no I/O, so it unit-tests without a subprocess. Exports `STOP_REASONS` and `stopReasonFromSdkResult(message)` / `stopReasonFromCodexTurn(params)`. |
| `packages/agensis-cli/src/connectionExecutors.mjs` | In the pump's `result` branch (`:394-403`), read `message.stop_reason`, `message.subtype`, `message.terminal_reason`, `message.permission_denials`, `message.num_turns`, `message.usage`, `message.total_cost_usd` and attach a `stop` object to the resolved result. Same for `turn/completed` in the codex executor (`:800-808`). |
| `packages/agensis-cli/src/executor.mjs` | Pass `result.stop` through `createPrimaryExecutor` and `createSandboxExecutor` unchanged (both currently rebuild the result object and would drop it). |
| `packages/agensis-cli/src/agensis.mjs` | `sendResult` at `:1149-1158` gains `stopReason` + `stopDetail`. The Amp path (`:1193-1215`) maps its existing `errorCode` vocabulary onto the same enum so one reader handles all runtimes. |

The vocabulary (deliberately ours, not ACP's — it has to cover three runtimes):

```
completed | cancelled | max_tokens | max_turns | max_budget | refused
| idle_timeout | hard_timeout | permission_denied | agent_error | connection_lost
```

Mapping from the Claude SDK (verified against `@anthropic-ai/claude-agent-sdk` 0.3.218,
`sdk.d.ts:4239-4290`):

- `subtype: 'success'` → `completed`, unless `terminal_reason` says otherwise
  (`aborted_streaming`/`aborted_tools` → `cancelled`, `max_turns` → `max_turns`,
  `budget_exhausted` → `max_budget`, `prompt_too_long` → `max_tokens`).
- `subtype: 'error_max_turns'` → `max_turns`; `'error_max_budget_usd'` → `max_budget`;
  `'error_during_execution'` → `agent_error`.
- `permission_denials.length > 0` on an otherwise-failed turn → `permission_denied`.

**Server (`agensis` repo)**

| File | Change |
|---|---|
| `server/agent-jobs.cjs` | New `normalizeStopReason(value)` beside `ampResultMetadata` (`:335`): returns a member of the closed set or `''`. Never a passthrough. `finalizeAgentJobResult` (`:382`) merges `{ stopReason, stopDetail, numTurns, costUsd }` into `mergedMetadata`. |
| `server/agent-jobs.cjs` | `finalizeStuckJob` (`:198-248`) writes `stopReason: 'connection_lost'` or `'hard_timeout'` into metadata so a reaped job is distinguishable from one that ended on its own. Its placeholder text (`:228`) becomes reason-specific: "hit its token limit" reads very differently from "stopped responding". |
| `server/agent-jobs.cjs` | Add `stopReason` to `handleAgentJobResult`'s accepted fields. Nothing else on the frame changes. |

No DDL. `agent_jobs.metadata` is already jsonb and already broadcast. Bind the merged
**object**, never `JSON.stringify` — the `$n::jsonb` scalar-corruption trap is documented
at `agent-jobs.cjs:1119-1121` and has bitten before.

**Frontend (`agensis` repo)**

| File | Change |
|---|---|
| `src/types/index.ts` | `AgentJob['metadata']` gains an optional `stopReason` of the union type. |
| `src/lib/agentStopReason.ts` *(new)* | `stopReasonLabel(reason)` → the one human sentence. Pure, unit-testable, and the single place the wording lives. |
| `src/components/chat/...` (the transcript row that renders a failed job) | Show the label instead of the raw `error` string when a reason is present. Fall back to today's behaviour when it is absent. |

### 4.2 Item B — idle deadline separate from hard deadline

Today: `config.timeoutMs` (30 min) is passed as `timeoutMs` into the executor
(`agensis.mjs:1095`) and fires one flat timer (`connectionExecutors.mjs:548-555`). The
server independently reaps on 10 minutes of content-silence
(`agent-jobs.cjs:303-323`). The server's reaper cannot stop the subprocess; it only
rewrites the row. So a silently-wedged agent keeps a CLI running on someone's laptop for
another 20 minutes after we have already told the human it stopped.

| File | Change |
|---|---|
| `packages/agensis-cli/src/agensis.mjs` | New `idleTimeoutMs` (default 9 min — deliberately just **inside** the server's 10-minute reaper so the daemon decides first and reports a real reason, rather than the server guessing). `--idle-timeout` flag, `AGENSIS_IDLE_TIMEOUT` env. Passed alongside `timeoutMs`. |
| `packages/agensis-cli/src/connectionExecutors.mjs` | Per-turn idle watchdog: any pump activity for the active turn (delta, step, segment, tool result) rearms it. On expiry: interrupt, resolve `stopReason: 'idle_timeout'`. The existing `timeoutMs` timer keeps its role as the hard ceiling and now resolves `'hard_timeout'`. |
| `packages/agensis-cli/src/connectionExecutors.mjs` | **Bounded cancel drain.** Today abort and timeout both call `closeSession` immediately (`:544`, `:552`) — the session is destroyed, so the next job pays a cold start. buzz's `cancel_with_cleanup_grace` gives the agent a short window to acknowledge and only then gives up. Adopt: `interrupt()`, wait up to 5 s for the pump to settle the turn, and only tear the session down if it does not. A drain that expires reports `cancel_drain_timeout` in `stopDetail`, never as a fresh `hard_timeout` — buzz's note about double-jeopardy (`acp.rs:966-990`) is the right instinct and applies to us identically. |

The 9-vs-10-minute relationship is the load-bearing detail and must be a named constant
with a comment on both sides, because it is otherwise two magic numbers in two repos that
silently invert if either moves.

### 4.3 Item C — session pool

| File | Change |
|---|---|
| `packages/agensis-cli/src/sessionSlots.mjs` *(new)* | Pure allocator: `claim(silo, lane)` → slot index, `release(silo, slot)`, capped at N per silo. Lane-sticky (a lane that ran on slot 2 prefers slot 2), LRU eviction when a new lane needs a slot and all are bound but idle. No I/O; unit-testable in isolation, which is how buzz tests `pool_lifecycle.rs`. |
| `packages/agensis-cli/src/agensis.mjs` | `sessionKey` at `:1110` becomes `${workspaceId}:${agent}#${slot}`. Claim before `executor.run`, release in a `finally` — a leaked slot is a permanent capacity loss, and unlike Rust nothing here will catch it for us. |
| `packages/agensis-cli/src/connectionExecutors.mjs` | No structural change: the existing `sessions` Map is already keyed by `sessionKey`, so N keys give N sessions for free. The keyed mutex keeps doing its job *per slot*, which is exactly what it should have been doing. Add a slot-release hook to the pump's `finally` (`:478-492`) so a session that dies frees its slot instead of stranding it. |
| `packages/agensis-cli/src/supervise.mjs` | **Update the self-update idle guard** to mean "no slot busy" rather than "no session active". Non-optional; see §3.2. |
| `packages/agensis-cli/src/agensis.mjs` | `N` = `config.sessionSlots`, default **1** for the first release (today's behaviour exactly), settable via `--session-slots` / `AGENSIS_SESSION_SLOTS`. Clamp to `[1, maxConcurrency]` — more slots than the queue will ever use is pure memory, and each slot is a live `claude` process. |

Deliberately **not** adopted from `pool.rs`: lazy wake with exponential backoff
(`pool_lifecycle.rs`). Our sessions are already created on demand at first use
(`ensureSession`, `connectionExecutors.mjs:311`), and `confirmedUnavailable`
(`executor.mjs:25`) already stops us re-probing a family that failed. Adding a retry
state machine on top would be a third mechanism for the same concern.

---

## 5. Test plan

**Runner globs — get these wrong and the test silently never runs.**

- agensis backend: `tests/*.test.cjs` — node runner, **top level only**.
- agensis frontend: `tests/unit/**/*.test.ts` — vitest.
- agensis smoke: `tests/smoke/**/*.smoke.ts`.
- agensis-agent: `tests/*.test.cjs` and `tests/*.test.mjs` — node runner, top level only
  (`package.json`: `node --experimental-test-module-mocks --test tests/*.test.cjs tests/*.test.mjs`).
- agensis-agent unit: `tests/unit/**` — vitest.

| Test file | Runner | What it pins | Mutation that must break it |
|---|---|---|---|
| `agensis-agent/tests/unit/stopReasons.test.ts` | vitest | Every SDK `subtype` and `terminal_reason` maps to exactly one enum member; an unknown `terminal_reason` falls back to the subtype's mapping, never to `completed`. | Make the unknown case return `completed`. |
| `agensis-agent/tests/agent-connection-executors.test.cjs` (extend; 22 tests today) | node | A fake `queryFn` result carrying `subtype:'error_max_turns'` surfaces `stop.reason === 'max_turns'` on the resolved result — driven through the real `createClaudeSdkExecutor`, not the mapper. | Delete the `stop` assignment in the pump's result branch. |
| `agensis-agent/tests/agent-connection-executors.test.cjs` | node | **Idle timeout.** A session that emits deltas for 3 ticks then goes silent resolves `idle_timeout`, not `hard_timeout`, and the hard timer never fires. Use an injected clock or a millisecond-scale `idleTimeoutMs`. | Rearm the idle timer from the hard timer instead of from pump activity. |
| `agensis-agent/tests/agent-connection-executors.test.cjs` | node | **Cancel drain.** After abort, a fake query that settles the turn within the grace window keeps the session in the pool; one that does not gets closed and reports `cancel_drain_timeout`. | Restore the unconditional `closeSession` on abort — the first assertion must go red. |
| `agensis-agent/tests/unit/sessionSlots.test.ts` | vitest | Two lanes claim two distinct slots at N=2; a third lane at N=2 waits or reuses the LRU slot; **release in every exit path** — claim, throw, release, claim again must succeed. | Remove the `finally` release; the fourth claim must fail. |
| `agensis-agent/tests/agent-queue-cancel.test.mjs` (extend) | node | End-to-end: with `sessionSlots=2`, two jobs on different lanes produce two distinct `sessionKey`s reaching the executor. **This is the test that would have caught the current no-op**, and it must be written to fail against today's code before the fix lands. | Revert `sessionKey` to the silo-only form. |
| `agensis/tests/agent-jobs-stop-reason.test.cjs` | node | `normalizeStopReason` accepts each enum member and returns `''` for `'<img src=x>'`, `'COMPLETED'`, `'completed; drop table'`, `''`, `null`, an object, and a 10 kB string. | Make it a passthrough for any non-empty string. |
| `agensis/tests/agent-jobs-stop-reason.test.cjs` | node | A result frame with **no** `stopReason` produces byte-identical metadata to today's code — the backward-compatibility pin. | Default the reason to `'completed'` when absent. |
| `agensis/tests/agent-jobs-stop-reason.test.cjs` | node | `finalizeStuckJob` writes `stopReason:'connection_lost'` **and** still writes `status='error'`. The status assertion is not redundant: `'failed'` is outside the CHECK constraint and the resulting throw is swallowed (`agent-jobs.cjs:198-213`) — that exact bug wedged a DM indefinitely. | Change `'error'` to `'failed'`. |
| `agensis/tests/unit/agentStopReason.test.ts` | vitest | Every enum member has a distinct non-empty label; an unknown value returns `''` so the UI falls back to the raw error rather than rendering `undefined`. | Return the raw reason string as the label. |

**On mock-DB tests.** The stop-reason server tests must assert against the **object bound
to the update**, not against a mock that re-implements the metadata merge. A mock that
restates the merge tests the mock (`MEMORY.md` → `mock-db-tests-can-be-vacuous`). The
concrete shape: capture the `db.unsafe` call's params array, assert
`params[1].stopReason`, and assert `typeof params[1] === 'object'` — the second half
catches a `JSON.stringify` regression, which is a real failure mode in this file.

**Not covered by any test we can write cheaply**: whether the Claude SDK's `interrupt()`
actually ends a turn without killing the session. That is the biggest unknown in item B
and needs a manual check against the real CLI before the drain window is tuned.

---

## 6. Migration and rollout

**No data migration. No backfill. No DDL.** Everything server-side lands in
`agent_jobs.metadata`, which already exists in all three schema places
(`server/index.cjs:1090`, `database/neon-schema.sql`, migrations). Existing rows simply
have no `stopReason` key, and every reader treats absent as "unknown", which is today's
behaviour.

**Deploy lanes** (see the `deploy-targets` skill — this is where features here go inert):

| Change | Lane |
|---|---|
| `server/agent-jobs.cjs` (required by `server/index.cjs`) | **`fly deploy`.** Nothing else picks it up. A local restart does not. |
| `src/types/index.ts`, `src/lib/agentStopReason.ts`, transcript row | **Netlify** — auto-deploys on push to the branch that serves the site. |
| `packages/agensis-cli/**` | **`npm publish @agensis/agensis-agent`** (bump version + `SOURCE_VERSION`) for every other daemon, **plus a local daemon restart** for the process running here. Both, not either. |
| `netlify/functions/backend.mjs` | Not touched. The serverless mirror has no websockets, so it never sees `agent_job_result`. |

**Order matters.** Fly first, npm second. A new daemon sending `stopReason` to an old Fly
is harmless (the field is ignored), but an old daemon against a new Fly is the common
case during a staged rollout and is what the backward-compatibility test pins. Deploy Fly,
confirm logs are clean, then publish.

**Rollback, concretely:**

- Item A: `stopReason` is additive and ignorable. Rollback = redeploy the previous Fly
  image; stale `metadata.stopReason` keys on old rows are inert.
- Item B: revert the daemon version. The server's 10-minute reaper is untouched and
  remains the backstop, so a rolled-back daemon degrades to exactly today's behaviour.
- Item C: `AGENSIS_SESSION_SLOTS=1` restores current behaviour **without a redeploy** —
  which is why it is a runtime setting and not a compile-time constant. Default it to 1
  for one release; flip to `maxConcurrency` in the next once the slot allocator has run
  in anger.

**Docs**: `AGENTS.md` gains a short subsection under the 2026-07 cross-cutting list
covering the stop-reason vocabulary, the 9-vs-10-minute relationship, and
`AGENSIS_SESSION_SLOTS`. `public/release-notes.json` needs an entry — item A is
user-visible (the failure text in chat changes) and that file is hand-maintained
(`AGENTS.md:299-307`).

---

## 7. Risks, effort, and what v1 will not build

### 7.1 Ranked risks

1. **Slot leak deadlocks a silo** (item C). A claim without a matching release
   permanently removes capacity; at N=1 that means the agent stops answering entirely and
   looks exactly like a wedged DM — a failure mode this repo has already lived through
   (`MEMORY.md` → `wedged-dm-phantom-job-fix`). *Mitigations*: release in `finally` and in
   the pump's terminal `finally`; a unit test that leaks deliberately; and a
   defence-in-depth idle sweep that reclaims a slot whose session is closed. Default N=1
   means the first release cannot regress capacity.
2. **The self-update idle guard drifts** (item C). Slots change what "idle" means, and a
   self-update landing mid-turn on slot 2 corrupts a live conversation. *Mitigation*:
   same PR, with a test. Called out separately because it is a cross-pack interaction
   that a reviewer of item C alone would not think to check.
3. **A daemon-supplied stop reason reaches a transcript unvalidated** (item A). This is
   the security regression in the set: a websocket string from someone else's machine
   rendered into a human's chat. *Mitigation*: closed enum, validated server-side, with
   the hostile-input test above. Do not rely on the frontend to sanitise.
4. **The idle timeout fires on a legitimately slow turn** (item B). A coding agent can
   think for minutes without emitting a token — killing those was the original complaint
   that set the server's window to 10 minutes (`agent-jobs.cjs:298-302`). *Mitigation*:
   9 minutes, rearmed by steps and segments as well as deltas (a tool-only stretch is
   activity, not silence), and configurable.
5. **Cross-channel context stops bleeding** (item C). Strictly better, but if anyone has
   come to rely on an agent remembering across channels this looks like amnesia.
   *Mitigation*: the flag, plus a release note.
6. **`total_cost_usd` leaks into fanout.** Low severity, easy to do by accident since
   metadata is broadcast. *Mitigation*: store it, do not render it in v1; check
   `sanitizeRealtimeRow` explicitly during review.

### 7.2 Effort

| Item | Estimate | Confidence |
|---|---|---|
| A — stop reasons | 1.0 d | High. The data is already on the wire; this is plumbing plus a validator. |
| B — idle vs hard deadline, bounded drain | 1.5 d | Medium. |
| C — session pool + supervise guard | 2.5 d | Medium-low. |
| **Total v1** | **5.0 d** | Medium. |
| (Optional, separate decision) ACP family adapter | +1.5 d | Low-medium — depends on which ACP agents we actually want. |

**Biggest unknown**: whether `query.interrupt()` on the Claude Agent SDK reliably ends a
turn and leaves the session reusable. Today we never find out, because we destroy the
session immediately after interrupting (`connectionExecutors.mjs:543-544`). buzz's
`cancel_with_cleanup` exists precisely because some ACP servers keep streaming after a
cancel (`acp.rs:963-975`), so this is a known hazard in the category. **Spend the first
half-day of item B testing this against the real CLI before designing around it.** If
interrupt turns out not to be reusable, item B shrinks to "report a better reason" and
the drain window is dropped.

Second unknown, smaller: whether `terminal_reason` is populated consistently by
claude-agent-sdk 0.3.218 or only in some paths. It is typed optional
(`sdk.d.ts:4253`, `:4283`). The mapping must degrade to `subtype` when it is absent, and
the test above pins that.

### 7.3 Deliberately not in v1

- **ACP as a protocol or a runtime family.** Its own decision, with its own budget. The
  detection is already there (`server/lib/capabilities.cjs:233-234`) and idle, so nothing
  is lost by waiting.
- **The observer / raw wire trace.** Deferred on the security grounds in §3.3. If it is
  ever wanted, the shape to copy is buzz's: a bounded in-process ring, opt-in, and
  encrypted before it leaves the machine — not a debug endpoint.
- **Event batching and dedup modes** (buzz `queue.rs`: Drop vs Queue, 50-event batches).
  Our job model creates one job per trigger with a DB uniqueness invariant behind it
  (`insertActiveAgentJob`, `agent-jobs.cjs:66-81`), and `dedupeKey` (`queue.mjs:25-29`)
  already collapses a burst from one person. Batching would have to move server-side and
  fight `hasActiveBurstJob`. Not worth it until someone actually complains about mention
  bursts.
- **Retry with backoff and dead-lettering** (buzz: 10 retries, 5 s→300 s, then
  dead-letter). We currently fail a job and tell the human to send again
  (`agent-jobs.cjs:228`). Automatic retry of a coding agent's turn is a product decision
  about idempotence, not a harness feature — a half-applied edit retried is worse than a
  clean failure.
- **Lazy pool wake with exponential backoff** (`pool_lifecycle.rs`). Covered by
  `ensureSession` plus `confirmedUnavailable`; a third mechanism would obscure both.
- **Restoring per-result tool chips.** Adjacent and cheap, but out of this pack's scope.
  Noting it here so it is not lost: `server/agent-jobs.cjs:1057-1059` hardcodes
  `message_kind = 'tool_step'` and never persists `step.kind`, so the daemon suppresses
  successful tool-result chips because the DB cannot tell a call from its result
  (`connectionExecutors.mjs:454-463`). `messages.message_kind` is plain `text` with no
  CHECK constraint (`server/index.cjs:1210`), so storing the kind needs no DDL — only a
  server change plus a frontend case in `src/components/chat/toolSteps.ts`. Worth its own
  small ticket.

---

## 8. Notes for whoever implements this

- **Read `AGENTS.md` first**, particularly the interactive-tool-approvals section
  (`:47-79`) before touching `connectionExecutors.mjs`. The permission model has several
  invariants that are not obvious from the code and that item C's slots interact with.
- **Verify locally, not in CI.** `npm run ci` is the gate; GitHub Actions on this repo
  finishes with zero steps executed (`AGENTS.md:329-333`).
- **Two repos, one wire contract.** Any change to the `agent_job_result` frame needs both
  sides in the same review, and `agensis-agent/tests/daemon-wire-contract.test.cjs` is
  the test that actually exercises a real daemon process against a real socket — extend
  it rather than writing a third mock of the handshake.
- **Assumptions I could not verify without running things** (deliberately not run, per
  the brief's no-builds rule): that `interrupt()` leaves an SDK session reusable; that
  `terminal_reason` is populated on the paths we care about; and the real-world
  distribution of `stop_reason` values, which I inferred from the type definition at
  `sdk.d.ts:4239-4290` rather than from observed traffic.
