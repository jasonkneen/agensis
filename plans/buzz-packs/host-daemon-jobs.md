# host-daemon-jobs — Host daemon job execution

Pack rank 11, priority 30, domain `agent-runtime`.
Source pack: `/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/host-daemon-jobs/`
Analysed against `main-next` @ 78fe79f, 2026-07-29. No code was written or run.

---

## 1. Verdict

**Reject the transfer.** This pack does not describe a buzz capability flowing into
agensis. It describes *our own* capability flowing out. `pack.json` is explicit —
`"source_system": "agensis-agent"`, `"target_systems": ["buzz"]`, and every source
anchor is a path in our own daemon repo (`packages/agensis-cli/src`, our `README.md`,
our `AGENTS.md`). `PROMPT.md` is titled "Recreate: Host daemon job execution (**for
buzz**)" and its target-stack hints are "Buzz: Rust crates, Nostr kinds,
Postgres/Redis relay". There is nothing here for us to adopt: we would be
reimplementing the thing the extractor read to write the pack.

The team lead flagged a discrepancy with `recommendation.json`, which says
`"target_system": "agensis"` and gives the rationale *"Transfer from agensis-agent
into agensis to close the capability gap on 'agent-runtime'. Matrix dimension 'Local
host agent daemon' currently favors agensis-agent."* **That line is the bug, and it is
a modelling bug, not a routing typo.** The extractor scanned three repos and treated
`agensis-agent` as a third *system* peer to `agensis` and `buzz`. It is not — it is the
host half of one product whose server half is this repo. The two halves already talk
over an authenticated WebSocket that this very repo defines. So the recommendation
layer produced a real-sounding sentence ("close the capability gap") describing a gap
that cannot exist: `server/agent-jobs.cjs` is 1,240 lines of nothing but the server end
of that exact protocol. Both files are wrong in different ways; neither yields work.
Expect the same inversion on any other pack whose `source_system` is `agensis-agent`.

**What already exists, with citations:**

| Capability the pack names | Where it lives today |
| --- | --- |
| Authenticated connect | connect-token model (`aga_…`), `server/agent-connections.cjs:647` registers the socket; `createAgentConnectToken` / `hashAgentToken` mint and verify |
| Receive job | `server/agent-jobs.cjs:66` `insertActiveAgentJob`; daemon side `packages/agensis-cli/src/agensis.mjs:585` enqueues on `agent_job` |
| Run CLI in a working directory | `packages/agensis-cli/src/executor.mjs:12` `createLocalExecutor`, `:38` `createPrimaryExecutor` (pooled Claude SDK / codex app-server), `connectionExecutors.mjs` |
| Stream logs/result | `server/agent-jobs.cjs:810` delta, `:955` tool step, `:1073` segment, `:702` result |
| Working-directory sandbox/permission mode | `packages/agensis-cli/src/agensis.mjs:1720` `resolveHostFolders`, `:1748` `resolveAdditionalDirectories`; server-side `host_folders` is MANAGE_ONLY so a `write` member cannot widen filesystem access |
| One-active-job invariant | M15 partial unique index, `server/index.cjs:1600` |
| Liveness / stuck-job recovery | `server/agent-jobs.cjs:87` `isAgentJobLive`, `:133` `hasActiveBurstJob`, `:198` `finalizeStuckJob`, `:259` `rehomeRunningJobs`, `:275` `failConnectionJobs`, `:303` `reapStuckAgentJobs` |
| A second execution lane | farm mode — `server/agent-jobs.cjs:611` `dispatchFarmAgentJob`, `server/farm-routes.cjs:183` |
| A third execution lane | MCP pull worker — `server/agent-jobs.cjs:737` `claimMcpJob` (`FOR UPDATE SKIP LOCKED`), `:790` `reapStuckMcpJobs` |
| Hosted vs bring-your-own sandbox | `run_mode` / `sandbox_provider` / `sandbox_config` at `server/index.cjs:845-847`, routed at `:4978-4982`; `packages/agensis-cli/src/sandbox/e2b.mjs` |

We are also well past the pack's description in ways it does not mention at all:
segmented streaming (one message per text block rather than one growing bubble),
per-tool-call step chips, a permission broker that survives daemon reconnects,
peer-to-peer LAN job handoff between daemons (`agensis.mjs:236` `handoffJobToPeer`),
Amp orb thread continuity with server-side validation (`agent-jobs.cjs:354`
`validateAmpJobResult`), and side-by-side self-update with rollback (pack #12, shipped
in daemon 0.1.43/0.1.44).

**So the deliverable is the gap analysis, not a build plan.** Section 3 works through
every candidate the team lead named. Three findings are worth acting on; two of them
are defects rather than missing features, and none of them come from buzz. Sections
4-7 scope only those three. If you are triaging, the one to read is **G1** — it is a
live correctness bug in the farm lane.

---

## 2. What the pack actually proposes

Stripped of the inversion, `pack.json` asks buzz to build:

- an authenticated host-side daemon that connects out to a cloud workspace;
- the workspace dispatches a job; the daemon runs a coding CLI in a configured
  working directory;
- logs and the final result stream back over the same connection;
- a working-directory sandbox / permission mode bounds what the CLI may touch;
- acceptance: "a simulated job/mention runs to completion with streamed progress".

The `code_anchors` carry no source at all — one directory listing and two truncated
README/AGENTS excerpts from our own repo. There is no algorithm, no schema, no state
machine, no wire format. As reference material for us it is empty.

**Where buzz's assumptions would not transfer even if the direction were reversed:**

- **Rust crates.** Our daemon is Node ESM published as a single-file npm bundle; our
  server is CommonJS. Nothing crate-shaped survives.
- **Nostr event kinds.** Buzz models a job as a signed event on a relay. Our job is a
  Postgres row whose liveness is a *database fact* — deliberately, so a backend
  restart cannot lose it and two Fly instances cannot disagree about whether an agent
  is busy (`server/agent-jobs.cjs:5-11`). An event-log model would give up the M15
  unique index, which is the only thing that makes "one active turn per (session,
  agent)" true across instances.
- **Redis relay.** We have no Redis. Fan-out is `notifyDbSubscribers` over the
  WebSocket layer in `server/realtime.cjs`.
- **`buzz-acp` agent ops.** ACP is a client-side agent protocol; our daemon speaks a
  private hub protocol plus MCP. Not comparable surfaces.

---

## 3. Gap analysis

Each candidate the team lead named, with a verdict and evidence. "Matters" is my
judgement of whether closing it changes anything a user or operator would notice.

### G1 — Concurrency caps per host: **REAL GAP, and it is a live defect.** Matters: yes.

Two facts that are individually fine and jointly broken:

1. `dispatchFarmAgentJob` inserts the job **already `running`, with
   `started_at = now()`**, with no check that the agent is free
   (`server/agent-jobs.cjs:626-629`). The M15 unique index does not constrain it:
   the index is `ON agent_jobs (session_id, agent_id) WHERE status IN
   ('queued','running')` (`server/index.cjs:1600`) and farm jobs are inserted with
   `session_id = null`. Postgres treats NULLs as distinct in a unique index, so
   **there is no cap at all on concurrent farm jobs per agent.**
2. On the daemon, `laneKeyForJob` (`agensis.mjs:829`) keys the lane by
   `sessionId::threadParentId`. Farm jobs have both null, so **every farm job in the
   workspace shares one lane, `"::"`, and they run strictly serially** — behind a
   `--max-concurrency` that defaults to 2 lanes (`agensis.mjs:47`) but which cannot
   help here, because they are all one lane.

Consequence: dispatch five farm jobs to one agent and jobs 2-5 sit in the daemon's
serial lane emitting nothing. `updated_at` is only bumped by deltas/steps, which a
job that has not started does not produce. The farm reaper fires on
`(metadata->>'mode') = 'farm' and updated_at < now() - interval '31 minutes'`
(`server/agent-jobs.cjs:309`), so **a queued farm job is force-failed as "timed out"
before it ever runs**, and `getFarmAgentJob` reports it errored. The caller sees a
failure for work that was never attempted.

This is the "resource limits" question in the only form that actually bites us: not
CPU or memory, but *admission control*. It is worth fixing.

### G2 — Job cancellation semantics: **REAL GAP.** Matters: yes.

The daemon implements cancellation completely and correctly. `agensis.mjs:479-492`
handles `agent_job_cancel`, and it gets the ordering right — it denies any parked
permission request *first* (`permissions.cancelJob`), because a turn blocked on an
approval prompt is not watching its abort signal, *then* aborts the queue entry.

**The server can only reach that from the Farm.** Grepping the whole repo, the sole
sender of `agent_job_cancel` is `cancelFarmAgentJob` at `server/agent-jobs.cjs:698`,
reachable only via `POST /backend/integrations/farm/jobs/:id/cancel`
(`server/farm-routes.cjs:210`) behind `requireUserOrFarm('agents:dispatch')`. There
is no route, no WS message, and no UI control by which a workspace member watching an
agent work on the wrong thing can stop it. `src/components/chat/AgentWorkBadge.tsx`
renders the elapsed chip and nothing else; there is no `stopJob`/`cancelJob` anywhere
under `src/`.

The daemon even ships the intent detector for a plain-text "stop"
(`queue.mjs:42` `looksLikeCancel`, `:154` `cancelActive`) — **dead code**, exported and
never called from `agensis.mjs`.

Note the plumbing is already safe for this: `handleAgentJobResult` discards a late
result for a cancelled job (`agent-jobs.cjs:718-721`), and
`finalizeAgentJobResult`'s non-farm status guard is `status in ('queued','running',
'error')` (`:389-391`) — `cancelled` is excluded, so a straggling result cannot
resurrect a cancelled turn. The hard part is already done.

### G3 — Job priority / fairness across agents: **REAL GAP, small.** Matters: moderate.

`tasks.priority` exists with four levels (`server/mcp.cjs:713`, `low|normal|high|
urgent`), is settable from `create_task`/`update_task`, and is rendered in the UI.
The dispatcher ignores it: `drainAgentTaskQueue` orders `t.created_at asc, t.id asc`
(`server/task-dispatch.cjs:477`) and `taskQueuePosition` mirrors that ordering exactly
(`:265-277`). Marking a task urgent changes nothing about when it runs.

Fairness *across* agents is not a gap — it is not a thing we have. Each agent drains
its own FIFO one job at a time, and the drain is per `(workspace, agent)`. There is no
shared pool to be unfair about. Do not build a scheduler.

### G4 — Multi-host scheduling: **REAL GAP.** Matters: not yet.

Multiple daemons *can* register for the same agent — `connectedAgents` is keyed by
`connectionId` (`server/agent-connections.cjs:647`), not by agent. But
`findConnectedAgent` (`:181`) returns the **first** entry with an open socket in Map
insertion order. So with two hosts serving one agent, the older connection takes
every job and the second sits idle.

The inputs for a better choice are already on the wire and already stored: the
heartbeat carries `busy`, `queueSize`, and `daemon.{host,pid,platform,cwd}`
(`agensis.mjs:1793-1811`). Nothing reads them for dispatch. Closing this is
"least-loaded pick instead of first-match" — genuinely small — but I would not do it
until someone actually runs two hosts for one agent, because the *right* answer
differs by intent (failover vs. capacity vs. per-repo pinning) and picking wrong bakes
in a policy. Revisit when there is a user.

### G5 — Resource limits (CPU/memory/disk on the host): **NOT A GAP.** Do not build.

Neither system has them, and the pack does not mention them. There is no `ulimit`,
`rlimit`, cgroup, or `maxBuffer` anywhere in `packages/agensis-cli/src/`; the only
container reference is *detection* of one, to decide whether skipping permission
prompts is honest (`agensis.mjs:1755-1785`). This is correct. The daemon runs on a
machine the user controls, at their invitation, on their repo; capping a coding CLI's
memory produces a mysterious mid-refactor OOM, not safety. The containment lane that
does exist is the right one: `run_mode = 'sandbox'` with an ephemeral Firecracker
microVM (`sandbox/e2b.mjs`), where the VM boundary *is* the limit and the blast radius
is a throwaway clone.

The only bound worth having is time, and we have it: `DEFAULT_TIMEOUT_MS = 30 min`
(`agensis.mjs:42`) on the daemon, and `HARD_CEILING` at 30 minutes from `started_at`
on the server (`agent-jobs.cjs:314`).

### G6 — Retry / backoff policy: **NOT A GAP. Absent by design.** Do not build.

There is no retry for `agent_jobs`, and there should not be. A coding turn is not
idempotent: re-running a `claude -p` that already edited files, ran a migration, or
pushed a commit is strictly worse than surfacing the failure. `finalizeStuckJob`
instead writes a human-readable instruction into the placeholder — *"stopped
responding … Send again to retry"* (`agent-jobs.cjs:228`) — putting the retry decision
with the person who knows what half-finished state the repo is in.

That this is a deliberate choice rather than an oversight is visible one table over:
`orb_deliveries` **does** carry `attempt_count` (`server/index.cjs:1041`, incremented
at `:6466`) because webhook delivery genuinely is idempotent. We retry the things that
can be retried.

### G7 — Artifact capture from a run: **PARTIAL GAP.** Matters: only if sandbox mode grows.

Sandbox runs do produce a real artifact — `git add -A && git diff --cached`
(`sandbox/e2b.mjs:87`). But `executor.mjs:74` folds the patch into stdout inside a
` ```diff ` fence, so it arrives as chat prose. There is no artifacts table (grep for
`artifact` across `server/*.cjs` returns nothing), no download, no "apply this patch".
For the daemon lane this is fine and arguably right — the agent worked in the user's
own checkout, so the artifact *is* the working tree, and `git diff` is one command
away. It only becomes a real gap when sandbox mode gets meaningful use, at which point
the patch is the entire product of the run and dropping it into a markdown fence is
lossy (truncation, no provenance, no apply path). Defer, and revisit alongside sandbox
adoption rather than on its own.

### G8 — Per-agent vs per-host concurrency caps: **covered by G1/G4.**

Per-*agent* is enforced twice: the M15 index for session jobs, and
`agentHasAnyActiveJob` (`agent-jobs.cjs:124`) which the task drain consults so an
agent mid-turn *anywhere* is treated as busy. Per-*host* is the daemon's
`--max-concurrency` (default 2 lanes, `agensis.mjs:47`), invisible to the server. The
only place the missing server-side view actually causes harm today is the farm lane
(G1); everywhere else the two caps happen to agree.

---

## 4. Work breakdown

Scope: **G1, G2, G3 only.** This work comes from the audit above, not from the pack —
nothing in the pack is being implemented. G4/G7 are deferred with a named trigger;
G5/G6 are rejected outright.

### Build order (vertical slice first)

**Slice 1 — G1 farm admission control (server only, no DDL, no daemon change).**
Smallest change that removes a live defect, and it is independently shippable.

- `server/agent-jobs.cjs` — in `dispatchFarmAgentJob` (currently `:611`), before the
  insert, count in-flight farm jobs for this `(workspace_id, agent_id)`:
  ```sql
  select count(*)::int as inflight from agent_jobs
   where workspace_id = $1 and agent_id = $2
     and status in ('queued','running')
     and (metadata->>'mode') = 'farm'
  ```
  If `inflight >= cap`, throw `Object.assign(new Error('The selected agent is at
  capacity'), { status: 429, code: 'agent_at_capacity' })`. Reason: stop admitting
  work the daemon cannot start inside the reaper window.
- Same file — resolve `cap` as
  `Number(target.capabilities?.maxConcurrency) || Number(process.env.AGENSIS_FARM_MAX_INFLIGHT) || 2`.
  Reason: prefer what the daemon advertises; `2` matches `DEFAULT_MAX_CONCURRENCY`.
  Note the daemon does not advertise `maxConcurrency` today — the `capabilities` read
  is forward-compatible and will simply fall through to the env/default until a future
  daemon release adds it. Do **not** block this slice on a daemon release.
- `server/farm-routes.cjs` — no change; `jsonError(res, error.status || 500, error)`
  at `:196` already propagates a 429. Verify in the test, do not assume.

Deliberately *not* in slice 1: changing farm jobs to insert as `queued`. That would
need a daemon-side `agent_job_started` frame to move `started_at`, i.e. an npm publish
and a fleet-wide upgrade, and the cap alone makes the timeout unreachable in practice.

**Slice 2 — G2 chat job cancellation (server + frontend, no daemon change).**

- `server/agent-jobs.cjs` — new `cancelAgentJob({ workspaceId, jobId, actorName })`,
  modelled on `cancelFarmAgentJob` (`:673`) but for session jobs. Reason: give the
  workspace the stop path the daemon has always supported. It must:
  1. load the job scoped by **both** `id` and `workspace_id` (mirror the scoping in
     `handleAgentJobResult:707-712`) — 404 otherwise;
  2. reject `run_mode = 'builtin'` jobs with 409 `builtin_not_cancellable` (see the
     unknown in §7 — `server/builtin-turn.cjs` has no `AbortController` anywhere in
     its 1,109 lines, so there is nothing to signal);
  3. `update … set status = 'cancelled', error = 'Stopped by <actor>', finished_at =
     now() where id = $1 and status in ('queued','running')` — the status guard is
     load-bearing, it is what stops a finished job being flipped;
  4. `notifyDbSubscribers('agent_jobs', 'UPDATE', …)`;
  5. rewrite the tracked placeholder to `@handle stopped (cancelled by <actor>)` using
     the same `content ~ PLACEHOLDER_CONTENT_RE` guard `finalizeStuckJob:232-237`
     uses, then `clearStrandedPlaceholders(job, responseMessageId)`;
  6. `scheduleTaskQueueDrain(job.workspace_id, job.agent_id, 'job_cancelled')` —
     cancelling frees the slot exactly as finishing does;
  7. send `{ type: 'agent_job_cancel', jobId, reason }` to the connection, resolved the
     same way `cancelFarmAgentJob:696-698` does (exact `connection_id` first, then
     `findConnectedAgent`). MCP jobs need no frame — `submitMcpJobResult:780` already
     refuses a non-`running`/`error` job, so a cancelled MCP job cannot be completed.
- `server/agents-routes.cjs` — mount
  `POST /backend/agents/:id/jobs/:jobId/cancel` (`:id` is the agent, matching the
  existing convention at `:51`, `:80`, `:97`, `:115`), `requireAuth` +
  `enforceWorkspaceRole(req.userId, workspaceId, 'run_agents')`. Reason: `run_agents`
  is exactly the capability `DB_TABLE_ACCESS` assigns to `agent_jobs` update
  (`shared/backend-core.cjs:203`); `editor` and above hold it (`:173-175`), viewers do
  not. Body: `{ workspaceId }`. Response: `{ data: publicAgentJob, error: null }`.
- `server/index.cjs` — wire `cancelAgentJob` into the deps object passed to
  `mountAgentsRoutes`. Reason: routes take injected deps, never imports.
- `src/lib/api.ts` (or wherever the agent-job calls live — confirm before editing) —
  `cancelAgentJob(workspaceId, agentId, jobId)`. Reason: one typed call site.
- `src/components/chat/AgentWorkBadge.tsx` — a Stop affordance beside the elapsed
  chip, shown only when the viewer holds `run_agents` and the job is daemon/MCP mode.
  Reason: this is already the "an agent is working here" surface; adding a second one
  would split the mental model.
- `src/hooks/useAgentWork.ts` — expose `jobId` and `mode` on the work record if it
  does not already carry them (**verify — I did not read this file**). Reason: the
  badge needs the job id to cancel.

**Slice 3 — G3 priority-ordered task drain (server only, no DDL).**

- New `shared/taskQueueOrder.cjs` exporting a single
  `TASK_QUEUE_ORDER_SQL` constant (e.g.
  `` case t.priority when 'urgent' then 0 when 'high' then 1 when 'low' then 3 else 2 end asc, t.created_at asc, t.id asc ``)
  and a pure `compareTaskQueue(a, b)` with the same semantics. Reason: the drain and
  the position quote **must** use one source or a human is told a position the drain
  will not honour.
- `server/task-dispatch.cjs:477` — use the constant in `drainAgentTaskQueue`.
- `server/task-dispatch.cjs:265-277` — use the same constant in `taskQueuePosition`;
  the `(created_at, id) < (self.created_at, self.id)` tuple comparison must become the
  matching priority-aware predicate.
- `shared/` is already linted for `.mjs` only (`eslint` globs `shared/**/*.mjs`) —
  a new `.cjs` file there will be **unlinted**, consistent with
  `shared/backend-core.cjs` but worth knowing. Do not let that stop the change; do
  keep the file small enough to review by eye.

### New DB tables/columns

**None.** No DDL, therefore nothing to add to `ensureRuntimeSchema()` and no Fly-boot
migration risk. G1 counts existing rows, G2 writes an existing enum value already
permitted by the `agent_jobs.status` CHECK constraint (`server/index.cjs:1087` —
`cancelled` is in the list), G3 reads an existing `tasks.priority` column.

### New routes / WS message types

| Method + path | Auth | Role | Body | Notes |
| --- | --- | --- | --- | --- |
| `POST /backend/agents/:id/jobs/:jobId/cancel` | `requireAuth` | `run_agents` | `{ workspaceId }` | 200 job, 404 wrong workspace, 409 builtin, 409 already terminal |

No new WS message types. `agent_job_cancel` already exists on both ends; this slice
only adds a second, authenticated way to send it.

---

## 5. Test plan

Globs, restated because they have bitten this repo twice: backend tests must be
`tests/*.test.cjs` (or `.mjs`) — **not** in a subdirectory. Frontend unit tests must be
`tests/unit/**/*.test.ts`. Anything else silently never runs.

### `tests/farm-job-capacity.test.cjs` (new, backend)

| Invariant | Mutation that must break it |
| --- | --- |
| The `(cap+1)`-th concurrent farm dispatch to one agent is refused with status 429 / `agent_at_capacity` | Delete the in-flight count query → the dispatch succeeds |
| The cap counts only `mode = 'farm'` rows in `queued`/`running` | Drop the `(metadata->>'mode') = 'farm'` predicate → an unrelated chat job consumes farm capacity and the test's first dispatch already 429s |
| A finished farm job frees capacity | Change the status filter to include `done` → the next dispatch is refused |
| A daemon-advertised `capabilities.maxConcurrency` overrides the env default | Hardcode the constant → the 3-capacity fixture refuses at 3 instead of 4 |

Do **not** write the test by having the mock DB return a canned `inflight` count that
the assertion then restates — that tests the mock. Seed the mock's `agent_jobs` array
with real rows and let the module's own SQL predicate select over them, so removing
the predicate actually changes the answer.

### `tests/agent-job-cancel.test.cjs` (new, backend)

| Invariant | Mutation that must break it |
| --- | --- |
| Cancel writes `status='cancelled'` and a `finished_at` | — |
| A job in another workspace 404s | Drop `and workspace_id = $2` from the load → it cancels cross-workspace |
| A `done` job is not flipped to `cancelled` | Remove `and status in ('queued','running')` from the UPDATE → a completed turn is retro-cancelled |
| A late `agent_job_result` for a cancelled job is discarded | Remove the `job.status === 'cancelled'` early return at `agent-jobs.cjs:718` → the job flips back to `done` |
| Cancel schedules a task-queue drain | Delete the `scheduleTaskQueueDrain` call → the recorded drain list is empty |
| The placeholder is rewritten, and messages that are **not** placeholders are untouched | Drop the `content ~ PLACEHOLDER_CONTENT_RE` guard → a real reply written this turn is overwritten. **This is the data-loss mutation; write this case first.** |
| A `builtin` job returns 409 rather than pretending to cancel | Remove the run_mode check → it reports success while the turn keeps running |

### `tests/agent-job-cancel-auth.test.cjs` (new, backend)

| Invariant | Mutation |
| --- | --- |
| A member without `run_agents` (viewer) gets 403 | Change the role arg to `'read'` → the viewer succeeds |
| An unauthenticated request gets 401 | Drop `requireAuth` → it succeeds |

### `tests/task-queue-priority.test.cjs` (new, backend)

| Invariant | Mutation |
| --- | --- |
| `drainAgentTaskQueue` and `taskQueuePosition` issue SQL containing the **identical** ordering clause | Edit one `ORDER BY` and not the other → assertion fails. This is the one invariant worth pinning at the SQL level, because it is a relationship between two call sites rather than a restatement of one |
| An `urgent` task assigned after a `normal` task is dispatched first | Revert the drain's ORDER BY to `created_at asc` → FIFO wins |
| Within one priority, FIFO still holds | Remove the `t.created_at asc` tiebreak → ordering is non-deterministic and the fixture fails |

### `tests/unit/taskQueueOrder.test.ts` (new, frontend runner)

Pure `compareTaskQueue` — rank ordering, stable within a rank, unknown/NULL priority
sorts as `normal`. Mutation: swap `high` and `low` in the rank map.

### Frontend

`tests/unit/agentWork.test.ts` exists; extend it (or add
`tests/unit/agentWorkStop.test.ts`) for: the Stop control renders only when the viewer
holds `run_agents` **and** the job mode is daemon/MCP; it is absent for builtin.
Mutation: drop the capability check → it renders for a viewer.

---

## 6. Migration + rollout

**Data migration: none.** No DDL, no backfill, nothing to reverse.

**Deploy lanes** (per the four-lane rule):

| Slice | Netlify (frontend) | `fly deploy` (backend) | npm publish `@agensis/agensis-agent` | local daemon restart |
| --- | --- | --- | --- | --- |
| G1 farm cap | no | **yes** | no | no |
| G2 cancel | **yes** (badge + api client) | **yes** (route + handler) | no — `agent_job_cancel` already ships in 0.1.44 | no |
| G3 priority | no | **yes** | no | no |

Fly before Netlify on G2, always: the frontend calls a route that must already exist,
or the Stop button 404s for everyone between the two deploys.

**Feature flags / staged rollout:**

- G1: `AGENSIS_FARM_MAX_INFLIGHT` (default 2). Rollback is setting it high — set it to
  `999` and the cap is effectively removed without a redeploy. There is no separate
  kill switch and none is needed.
- G2: no server flag. The route is additive; nothing calls it until the frontend
  ships. Rollback is a Netlify redeploy of the previous frontend, which removes the
  only caller; the route can stay.
- G3: `AGENSIS_TASK_QUEUE_PRIORITY` (default `on`) selecting between the new ordering
  constant and the legacy `created_at asc, id asc`. Rollback is `off` + restart, no
  redeploy. Worth the flag because ordering changes are the kind of thing an operator
  notices as "why did it do that one first" and wants reverted in seconds.

"Rollback" concretely: G1 and G3 are env changes on the Fly app. G2 is a Netlify
redeploy. None of the three can leave data in a state the previous version cannot
read.

---

## 7. Risk register + effort

Ranked. The first two are the ones that can cause harm.

1. **Cancel deletes or overwrites a real message (data loss).** `clearStrandedPlaceholders`
   deletes rows matching `PLACEHOLDER_CONTENT_RE` within the job's own window
   (`agent-jobs.cjs:170-193`). A cancelled turn that had already segmented has real
   replies on screen. *Mitigation:* reuse the existing function unchanged and pass
   `responseMessageId` as the keep-id exactly as `finalizeAgentJobResult:528` does;
   keep the `content ~ PLACEHOLDER_CONTENT_RE` guard on the rewrite UPDATE; write the
   "real reply survives cancel" test first, before the feature.
2. **Cancel route becomes a cross-workspace or under-privileged write (security
   regression).** *Mitigation:* scope the load by `workspace_id` as
   `handleAgentJobResult:707-712` does; gate on `run_agents`, matching
   `shared/backend-core.cjs:203`; a dedicated auth test file so the check cannot be
   quietly dropped in a refactor.
3. **The farm cap refuses legitimate work.** If a daemon runs with
   `--max-concurrency 8`, a cap of 2 throttles it to a quarter of its capacity.
   *Mitigation:* read `capabilities.maxConcurrency` first, env second; log every 429
   with the resolved cap and its source so a wrong cap is diagnosable from Fly logs
   rather than by inference.
4. **Priority ordering starves normal tasks.** A steady arrival of `urgent` work means
   a `normal` task never reaches the head. *Mitigation for v1:* none — accept it, and
   say so in the release note. If it bites, the fix is an age-promotion clause
   (`normal` older than 24h ranks as `high`), which is a one-line change to the shared
   constant. Do not pre-build it.
5. **Stop button reads as broken on builtin agents.** `run_mode` defaults to
   `'builtin'` (`server/index.cjs:845`), so a large share of agents in a typical
   workspace cannot be cancelled at all. *Mitigation:* do not render the control for
   builtin jobs rather than rendering one that 409s. A missing button is a smaller lie
   than a dead one.
6. **The G3 shared constant drifts back apart.** Two call sites, one constant, no
   compiler enforcing it. *Mitigation:* the "both SQL strings contain the identical
   clause" test is specifically there to catch this, and it is the reason that test
   asserts on SQL text despite SQL-text assertions usually being a smell.

**Effort:** ~2.5 engineer-days total — G1 0.5d, G2 1.5d (0.5 server, 0.75 frontend,
0.25 tests), G3 0.5d. Confidence: **medium-high** on G1 and G3 (server-only, no DDL,
narrow blast radius); **medium** on G2, entirely because of the frontend surface.

**Biggest unknown:** whether shipping cancel for daemon/MCP only is acceptable, or
whether builtin has to be in v1. `server/builtin-turn.cjs` contains no
`AbortController`, no `signal`, and no `abort` in 1,109 lines — cancellation there
means threading an abort signal through the whole in-process turn including the model
call, which is a separate piece of work of comparable size to the rest of slice 2. If
the answer is "builtin must work too", re-estimate G2 at 3-4 days and treat the signal
plumbing as its own slice. **This is worth asking before slice 2 starts, not during.**

**Deliberately NOT in v1:**

- Anything from the pack. Nothing in it applies to us.
- G4 multi-host / least-loaded dispatch — build when a second host for one agent
  actually exists.
- G7 artifact capture / an `agent_job_artifacts` table — build alongside sandbox
  adoption, not before.
- G5 host resource limits — rejected; the sandbox lane is the right containment.
- G6 automatic retry/backoff for agent jobs — rejected; coding turns are not
  idempotent.
- Changing farm jobs to insert as `queued` plus an `agent_job_started` daemon frame.
  Correct, but it needs an npm publish and a fleet upgrade, and the G1 cap makes the
  defect unreachable without it.
- Wiring the daemon's `looksLikeCancel` so a plain-text "stop" in chat cancels the run.
  Tempting, and the code already exists — but a false positive silently kills real
  work, and there is no undo. Ship the explicit button first and see whether anyone
  asks for the shortcut.
