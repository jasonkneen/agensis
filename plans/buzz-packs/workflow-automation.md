# workflow-automation — YAML workflow automation

Pack rank 6, priority 75. Source: `repo-grab/out/extract-pack/workflow-automation/`.
Domain: automation. Stated target surface: "server flow-routes / workflow engine".

---

## 1. Verdict

**Adopt-modified, with two substantial rewrites of the pack's premise.**

The capability gap the pack names is real, but the pack has misdiagnosed it and the
recommendation has misnamed the target surface. agensis does not lack "a workflow
engine" — it has **three** automation systems already, each of which hardcodes one
axis of the trigger→action matrix and leaves the other axis fixed:

| System | Trigger | Action | Where |
|---|---|---|---|
| `agent_schedules` | time (fixed interval, not cron) | post a prompt + wake an agent | `server/index.cjs:5326` `runDueSchedules` |
| `agent_webhooks` | inbound HTTP with a URL token | make a session + wake an agent | `server/agent-webhooks-routes.cjs:104` |
| `flow_connections` | workspace DB event | POST to an external URL | `server/index.cjs:6403` `enqueueFlowWebhookEvents` |

Every cell is hardcoded. The one thing a user cannot express today is **"when X
happens inside agensis, do Y inside agensis"** without a code change — the
event-triggered/internal-action cell that none of the three cover. That, and only
that, is the gap. Adopt it.

Reject two things the pack asserts:

1. **YAML as the authoring surface.** The value of a declarative workflow here is
   not authoring ergonomics — it is that a *deterministic* condition evaluator can
   decide something **without a model call**, which is currently impossible in this
   product (see §2.2). That value is delivered by the executor and the stored
   record, not by the file format. YAML should be the read/diff/share *rendering*,
   and the wire format for both humans and agents should be structured JSON.
   Argued in full in §2.3.
2. **`server/flow-routes.cjs` as the target surface.** The recommendation's
   `target_surface` is wrong on a factual level. `flow-routes.cjs` is 110 lines of
   CRUD over `flow_connections` — an **outbound** integration record (a token +
   a signed webhook URL) for an external automation product. There is no engine
   there to extend. Building an internal workflow engine into it would collide two
   unrelated concepts under one already-overloaded word.

What already exists, with citations, is enumerated in §1.1. What I am proposing to
build is one new table, one pure evaluator module, one worker on the existing 1s
delivery cadence, three routes, and one window — approximately the surface area of
`thread-harvest.cjs`, which is the right size comparison.

If Jason wants a smaller bet: the **vertical slice in §5 step 1** (one trigger,
one action, no UI, MCP-only) is genuinely useful on its own and is ~2 days.

### 1.1 What already exists in agensis today

**Outbound event pipeline (complete, do not rebuild):**
- `server/flow-integration.cjs:11-23` — `FLOW_EVENTS`, a frozen list of 10 event
  names plus the reaction events from `shared/reaction-events.cjs`.
- `server/index.cjs:6345-6356` — `FLOW_EVENT_BY_CHANGE`, the `table:OP → event
  name` map. This is the entire trigger vocabulary the product has.
- `server/index.cjs:6358` `publicFlowEventRecord`, `:6395` `flowEventLocation` —
  the per-table projection and workspace/channel resolution.
- `server/index.cjs:6403` `enqueueFlowWebhookEvents` — called fire-and-forget from
  the single realtime chokepoint at `server/realtime.cjs:228`.
- `server/index.cjs:6471` `claimFlowWebhookDelivery` — `FOR UPDATE SKIP LOCKED`
  claim with a 30s lease and a `claim_token`, plus lease-expiry recovery of
  `inflight` rows.
- `server/index.cjs:6493` `deliverNextFlowWebhook` — signed POST
  (`x-agensis-signature`, `idempotency-key`), 10s timeout, `redirect: 'error'`.
- `server/index.cjs:7570-7577` — `flowDeliveryWorker`, a **1s** interval with an
  in-flight boolean guard, one delivery per tick.
- `server/flow-integration.cjs:194` `flowWebhookRetryDecision` — retryable status
  classification, exponential backoff capped at 300s, dead-letter at 8 attempts.
  Already unit-tested at `tests/flow-integration.test.cjs:77`.
- SSRF guard: `server/flow-integration.cjs:87` `normalizeFlowWebhookUrl` — HTTPS
  only off-loopback, rejects raw IPs, `.local`, `.internal`, and embedded creds.
- Loop guard precedent: `server/index.cjs:6425-6429` already skips a `messages`
  row whose `sender_id` is the connection itself, so an integration cannot be
  woken by its own post. **This is the exact shape the new engine needs.**

**Scheduled execution (complete):**
- `server/index.cjs:5326` `runDueSchedules` — atomic claim in a single UPDATE with
  `FOR UPDATE SKIP LOCKED`, `limit 10`, a `scheduleRunnerRunning` re-entrancy
  boolean, per-run history rows in `agent_schedule_runs`, `run_count`/`fail_count`.
- `server/index.cjs:5395` `reconcileSchedulesAtStartup` — clears the `running`
  flag so a restart cannot wedge a schedule.
- Fires from the 30s tick at `server/index.cjs:7567`, and eagerly from
  `server/schedules-routes.cjs:175` on "run now".
- Interval only — clamped 60s..30d at `server/schedules-routes.cjs:106`. **There
  is no cron parser anywhere in this repo** (verified by grep).
- UI: `src/components/windows/SchedulesWindow.tsx`, `src/hooks/useSchedules.ts`,
  window type registered at `src/types/index.ts:274`, opened at `src/App.tsx:1340`.

**Agent dispatch with bounded concurrency (complete, and the reason §4 is safe):**
- `server/task-dispatch.cjs:322` `dispatchTaskAssignment` — claim/lease
  (`TASK_ASSIGN_CLAIM_MS` 15s), capability check `run_agents`, rate limiter,
  `agentHasActiveJob` pre-check, and `undoTaskDispatch` rollback when the turn is
  refused.
- `server/task-dispatch.cjs:457` `drainAgentTaskQueue` — FIFO, **at most one
  dispatch per call**, `TASK_QUEUE_MAX_STRIKES` = 3, and a re-entrancy set.
- `server/index.cjs:5042` `continueConversation` — a per-conversation lock,
  `max_agent_turns` budget, reply-cadence deferral.
- `agent_jobs` carries a partial unique index (one active job per session+agent).

**The house pattern for a new background worker (copy this):**
- `server/thread-harvest.cjs` in full. Note specifically: `:355`
  `runOneThreadHarvest` (compare-and-set claim on `status`), `:337`
  `finishHarvest` (always returns a result even when the UPDATE matched nothing,
  so a hard-deleted row cannot abort the drain), and `:405` `runDueThreadHarvests`
  — **bounded to 3 per tick, with the reason written down**: "a backlog of fifty
  deleted threads must not turn one tick into fifty serial model calls".

**RBAC and the client write boundary:**
- `shared/backend-core.cjs:172` `WORKSPACE_ROLE_CAPABILITIES` — five roles over
  `read | write | comment | run_agents | manage`.
- `shared/backend-core.cjs:186` `DB_TABLE_ACCESS` — per-table capability map for
  generic `/backend/db/*`.
- The read-only-to-client shape (`{ select: 'read', insert: 'manage', update:
  'manage', delete: 'manage' }`) is already used for `agent_schedules`,
  `agent_permission_requests`, `thread_harvests`, `huddles`, `huddle_events`,
  `orb_deliveries`, `feedback_reports`. Each carries a written justification.
  A new automations table takes exactly this shape.

**What does NOT exist:** any condition evaluator, any expression language, any
step sequencer, any per-workspace automation run budget, any cron parser, any YAML
dependency (`yaml`/`js-yaml` are absent from `package.json`), and any way for a
non-engineer to add a new trigger→action pair.

---

## 2. What the pack actually proposes

### 2.1 The pack itself

The pack is **thin**, and I want that on record. `pack.json` `code_anchors` contains
two entries, neither of which is source:

- `crates/buzz-workflow` — the "excerpt" is literally
  `// directory listing (not source dump):\nCargo.toml\nsrc`. No types, no schema,
  no step vocabulary, no condition grammar, no execution semantics.
- `ARCHITECTURE.md` — a truncated executive summary about Nostr, relays and
  communities. The word "workflow" appears twice, both times in a list of things
  the relay handles.

So everything below the one-line description (*"Declarative workflows as
YAML-as-code with simple evaluable conditions, webhooks, and event-triggered
steps — automation without bespoke server endpoints per flow"*) is my inference,
not extracted behaviour. I could not determine buzz's actual step vocabulary,
condition grammar, error semantics, or concurrency model from this pack. **No
design decision below rests on a buzz behaviour I claim to know.**

Reduced to what the description actually asserts, the concept is four things:
1. A workflow is a **declarative document**, not code.
2. It has **triggers** (events, webhooks) rather than a bespoke endpoint each.
3. It has **conditions** that are "simple evaluable" — not a general language.
4. It has **steps**, executed in order.

The insight worth taking is #2's rationale: today, every new automation in agensis
costs a route, a table, a worker, a test file and a UI. The three systems in §1
are proof. The declarative approach makes automation an artifact rather than a
deploy.

### 2.2 The point the pack misses, which is the actual argument for adopting it

In agensis today, **the only conditional executor in the system is a language
model.** Trace it:

- A schedule fires → posts a prompt → `continueConversation` → a paid turn
  (`server/index.cjs:5364-5370`).
- A task is assigned → wakes an agent in its DM → a paid turn
  (`server/task-dispatch.cjs:414-427`).
- A thread is discarded → `runAnthropicCompletion` decides what to keep
  (`server/thread-harvest.cjs:382`).
- A webhook arrives → makes a session → a paid turn
  (`server/agent-webhooks-routes.cjs:154`).

There is no path in this product by which "if the task is P0 and unassigned after
an hour, put it in #urgent" happens **for zero cost and with the same answer every
time.** That is what a declarative engine buys, and it is a genuinely new capability
here — not a nicer wrapper on an existing one. It is also the argument for
determinism over prompting: an automation that must be *right* (an escalation, a
compliance ping, an on-call handoff) cannot be a model call that is right most of
the time.

### 2.3 Is YAML the right authoring surface when the users are agents?

The brief asks this directly. My answer: **no as the wire format, yes as the
rendering.** Four reasons, in descending order of how much they should change the
design.

**(a) For an agent, a workflow DSL is a strict capability downgrade.** An agent
already has 30 MCP tools (`server/mcp.cjs`, verified count) including
`post_message`, `dispatch_agent`, `create_task`, `update_task`, `write_doc`,
`create_thread_item`, `add_memory`. It can already sequence them with real
reasoning between steps and react to what each returns. Asking it to emit a static
YAML step list asks it to pre-commit to a plan it can no longer adapt. The agent
gains nothing from YAML **except** that the result runs again later without paying
for the agent — which is exactly the §2.2 value, and is a property of *persisting a
definition*, not of *the syntax it was persisted in*.

**(b) YAML is the format most likely to fail silently in the hands of the
producers we actually have.** Both a model emitting a workflow and a human typing
one hit the same class of bug: significant whitespace, a tab that renders like
spaces, and the type coercions (`on:` → boolean `true`, `no` → `false`, `1.0` →
float, an unquoted version string mangled). None of these throw; they produce a
*different valid document*. A model that writes a schedule with a stray indent
produces an automation that runs the wrong step, at 3am, and the failure surfaces
as "why did that fire". JSON's failure mode is a parse error at the boundary,
which is the failure mode you want at an API edge.

**(c) It is a new parse-time dependency on untrusted input for no capability
gain.** There is no YAML parser in this repo today. Adding one means a third-party
parser processing text that a `manage`-role user (and, via MCP, an agent) supplies,
on the Fly machine, inside a `manage`-level surface. `JSON.parse` is in the
runtime, has no anchor/alias/merge-key features, and has no billion-laughs
equivalent. If YAML import lands later, the parser must be configured to reject
anchors and custom tags, with a size cap ahead of the parse.

**(d) But the *readable artifact* argument is real and should be honoured.** The
thing people actually want from "YAML-as-code" is: I can read it, diff it, paste it
into a channel, and copy it to another workspace. So:

> **JSON in, YAML out.** The stored definition is `jsonb`. The write routes and the
> MCP tool take typed JSON. The read route and the UI *render* YAML for display,
> copy and diff — server-side, from the validated JSON, with a hand-written
> serializer for the closed shape we control (no dependency, and it cannot emit
> anything that would not round-trip). Import-from-YAML is explicitly v2, and is
> when a parser dependency is justified by real demand rather than by a pack.

This gets the pack's actual value (a shareable, reviewable, deterministic artifact)
while the wire format stays the one that fails loudly.

### 2.4 Where buzz's architecture does not transfer

- **Nostr kinds are not our event vocabulary.** buzz adds a feature by defining a
  new `kind` integer; every event is a signed event on one relay, so "trigger on
  an event" is uniform by construction. Our events are a hand-maintained map from
  `(table, INSERT|UPDATE)` to a name — `FLOW_EVENT_BY_CHANGE`,
  `server/index.cjs:6345`. Ten entries. Notably **`tasks` is not in it**, so
  "when a task is created" is not currently an event at all. Adding table→event
  entries is cheap; it is also the thing that must be done deliberately, because
  every entry widens the outbound webhook surface too (same map).
- **One relay as sole source of truth does not hold.** We have two backends over
  one Postgres (see `AGENTS.md`), and the Netlify mirror has no long-running
  process — `server/schedules-routes.cjs:16-17` says so explicitly for schedules.
  Any worker is Fly-only, and the frontend must not assume otherwise.
- **Signed events give buzz free provenance.** We do not sign rows. Provenance for
  an automation-produced row has to be an explicit column/tag (§4.1), which is
  also what makes the loop guard possible.
- **Rust/`crates/*` says nothing about our module boundaries.** The house shape is
  a factory taking injected deps (`createThreadHarvest`, `createTaskDispatch`),
  because that is what makes the logic testable against a fake db.

---

## 3. Impact on our system

### 3.1 Subsystems touched

| Subsystem | Change |
|---|---|
| `server/realtime.cjs:228` (the one write chokepoint) | One added fire-and-forget call alongside `enqueueFlowWebhookEvents`. Same failure posture: an automation that cannot be queued must never cost the user their write. |
| `server/index.cjs` event vocabulary | `FLOW_EVENT_BY_CHANGE` / `publicFlowEventRecord` / `flowEventLocation` move to a shared module. A **move**, not a rewrite — both consumers must read the same map or the two trigger surfaces drift. |
| 30s reaper tick `server/index.cjs:7567` | One added call for the retry/reap sweep only. |
| 1s `flowDeliveryWorker` `server/index.cjs:7570` | A sibling 1s worker for automation runs. Not merged into it: a slow automation must not delay a webhook delivery. |
| `shared/backend-core.cjs` | New table added to `ALLOWED_TABLES` (`:31`), `WORKSPACE_SCOPED_TABLES` (`:160`), `DB_TABLE_ACCESS` (`:186`), `JSON_COLUMNS_BY_TABLE` (`:115`). |
| Frontend | One new window type + hook + view. |
| MCP | Three new tools with new scopes. |

### 3.2 What it breaks, or forces a migration of

**Nothing, if the scope in §6 holds.** No existing table changes shape. No existing
route changes contract. `agent_schedules`, `agent_webhooks` and `flow_connections`
are untouched in v1.

The one real hazard is the extraction of `FLOW_EVENT_BY_CHANGE` and friends out of
`server/index.cjs`. That map currently drives live outbound webhooks for anyone
using the Flows integration. A refactor that drops an entry silently stops their
automation. Mitigation: the new shared module is asserted against a literal
expected list in a test, so a deletion is a test failure rather than a quiet
regression (§7, invariant I1).

### 3.3 Relationship to the existing flow system — replace, extend, or separate?

**Separate concept, shared vocabulary, and a written convergence order.** Concretely:

- **`flow_connections` is not touched and is not renamed.** It is an outbound
  integration record for an external product literally called Flows (see the UI
  copy at `src/components/integrations/ConnectFlowsDialog.tsx:59-73`). Renaming it
  would break a shipped integration's documentation for a cosmetic win.
- **The new concept is called `automations`.** Deliberately a different word,
  because "flow" is taken by a vendor name in this codebase and a reader must not
  have to ask which one is meant.
- **They share the event vocabulary in code**, via the extracted shared module.
  One map, two consumers: "who wants to know" (webhook connections) and "what
  should happen" (automations).
- **v1 adds no outbound HTTP action.** Outbound HTTP is what `flow_connections`
  already does, with signing, idempotency keys, leases, retry classification and
  an SSRF guard. Re-implementing it inside the automation engine would create a
  second, less-tested SSRF surface reachable by `manage`. If someone wants
  "event → external URL", that is the existing Flows connection, today.

**And the convergence, so this does not become a permanent fourth system.** The
three existing systems become three cells of the same matrix, in this order:

1. **v2 — `schedule` trigger.** `runDueAutomations` grows a time trigger.
   `agent_schedules` then becomes a *view* over automations with
   `trigger.kind='schedule'` and a single `dispatch_agent` step. `SchedulesWindow`
   keeps working against the same route shape; the runner is deleted. This is the
   easy one and it removes `runDueSchedules` entirely.
2. **v3 — `webhook` trigger.** `POST /backend/webhooks/:token` resolves to an
   automation instead of an `agent_webhooks` row. Same URL, same token, so no
   integration anyone has configured breaks.
3. **Never — `flow_connections`.** It stays. It is the outbound edge and it is a
   different thing.

If the team is not prepared to commit to (1), **do not build this.** An event
engine that sits next to a schedule runner forever is worse than either alone.

### 3.4 Security and permission implications

- **`manage` on every write path.** An automation can dispatch an agent, which
  spends tokens and takes actions with the agent's authority. That is a standing
  grant, not a one-shot run, which is why it is `manage` and not `run_agents` —
  `run_agents` is "you may run an agent now"; `manage` is "you may configure the
  system to run agents without you". `agent_webhooks` (the closest existing
  analogue, also a standing agent-wake grant) is already `manage` on both its route
  (`server/agent-webhooks-routes.cjs:76`) and its `DB_TABLE_ACCESS` entry.
- **Read-only to clients via `/backend/db`.** `{ select: 'read', insert: 'manage',
  update: 'manage', delete: 'manage' }`, matching `agent_schedules`. A client must
  not be able to name what an automation does without passing the validator: a
  forged row with a `dispatch_agent` step is an agent-dispatch primitive available
  to anyone who can reach `/backend/db/insert`.
- **The automation actor is the automation's owner, not the triggering user.** An
  automation created by an admin, triggered by a message a `viewer` posted, must
  run with the *creator's* authority and must record both. Otherwise an automation
  is a privilege-escalation ladder: a viewer posts, and something happens that only
  a `manage` user could have done. Every run row records
  `automation.created_by` as actor and the triggering row's author separately.
- **Revocation must be real.** If the creator's workspace role is downgraded or
  they are removed, their automations must stop. Checked at *run* time, not only at
  create time — `getWorkspaceRole(created_by, workspace_id)` re-checked before any
  step that dispatches an agent, exactly as `dispatchTaskAssignment` re-checks at
  `server/task-dispatch.cjs:358-362`. This is the single most important control in
  the whole design and it is easy to omit.
- **No user-supplied URLs, no user-supplied code, no template execution in v1.**
  Interpolation is a fixed allowlist of field names into strings, never an
  expression evaluated at runtime (§4.2). This closes the entire class of "the
  condition language became a sandbox escape".
- **Connect-token model unaffected.** Automations are not a new identity. The MCP
  tools below run under an existing agent or integration connection and are
  scope-gated like every other tool (`TOOL_SCOPES`,
  `server/flow-integration.cjs:46`).

### 3.5 Interaction with work in flight

- **`thread_harvests` (shipped today)** — the direct pattern source. If the harvest
  review UI is still settling, land that first; this plan copies its worker shape
  and should not be racing edits to it.
- **`channel_bridges` (shipped today)** — a bridged message is an ordinary
  `messages` INSERT, so it flows through `server/realtime.cjs:228` and **will**
  trigger automations. That is probably desirable and definitely needs to be
  deliberate: a Telegram bridge plus a "reply to every message" automation is a
  paid model call per inbound Telegram message. The per-automation rate limit
  (§4.4) is what stops that being a billing incident.
- **`self-update-supervise` (pack #12, shipped)** — no overlap. Daemon-side.
- **Branch is `main-next`; `main` serves agensis.io.** Backend + DDL, so this needs
  a real `fly deploy` and cannot ride Netlify's auto-deploy.

---

## 4. Design

### 4.1 The stored shape

One table. `definition` is `jsonb` and is the *only* thing the executor reads.

```sql
-- Declarative workspace automation: one trigger, an optional condition, an
-- ordered list of steps. Read-only to clients; every write goes through
-- /backend/workspaces/:id/automations, which is the only place the definition
-- is validated.
CREATE TABLE IF NOT EXISTS automations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT false,   -- OFF by default; see §4.6
  trigger_event text NOT NULL,              -- a FLOW_EVENTS name, denormalised
                                            -- out of definition so the matcher
                                            -- can index it
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES app_users(id) ON DELETE SET NULL,
  -- Counters, for the list view and for the runaway check.
  run_count integer NOT NULL DEFAULT 0,
  fail_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_status text NOT NULL DEFAULT '',
  -- Set by the runaway guard (§4.4). A tripped automation stays disabled until
  -- a human clears it, and this column is why the UI can say WHY.
  disabled_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_automations_workspace ON automations(workspace_id, created_at DESC);
-- The matcher's only query: enabled automations in this workspace for this event.
CREATE INDEX IF NOT EXISTS idx_automations_trigger ON automations(workspace_id, trigger_event) WHERE enabled;

-- One row per (automation, triggering event). The queue AND the audit log.
CREATE TABLE IF NOT EXISTS automation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id uuid NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Stable per triggering row+version, exactly like the flow webhook event id
  -- (server/index.cjs:6421). Makes enqueue idempotent under a retried write.
  event_id text NOT NULL,
  event_type text NOT NULL,
  status text NOT NULL DEFAULT 'pending',   -- pending|inflight|done|skipped|error|dead
  -- How many automation hops produced this. Incremented from the run that wrote
  -- the triggering row. The cycle brake (§4.3).
  depth integer NOT NULL DEFAULT 0,
  attempt_count integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_expires_at timestamptz,
  -- The projected event record the run saw, so a run is readable after the
  -- source row has changed or been deleted.
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- Per-step outcome, appended as the run proceeds.
  steps jsonb NOT NULL DEFAULT '[]'::jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Idempotent enqueue: one row per automation per triggering event.
CREATE UNIQUE INDEX IF NOT EXISTS uq_automation_runs_event
  ON automation_runs(automation_id, event_id);
CREATE INDEX IF NOT EXISTS idx_automation_runs_due
  ON automation_runs(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_automation_runs_workspace
  ON automation_runs(workspace_id, created_at DESC);
-- The per-automation rate window (§4.4) counts rows in an interval.
CREATE INDEX IF NOT EXISTS idx_automation_runs_recent
  ON automation_runs(automation_id, created_at DESC);
```

Both belong in `ensureRuntimeSchema()` and therefore **run on Fly boot** — plus
`database/neon-schema.sql` and a new `supabase/migrations/<UTC>_automations.sql`.
Three places, per `AGENTS.md:23-31`.

`depth` is on the run and must propagate: an action that writes a row tags that row
so the next match knows its depth. For `messages` this rides
`messages.message_kind` / an added marker; for `tasks` it rides `source_type`. See
§4.3 for why a column is not enough on its own.

### 4.2 The definition shape

Deliberately small and closed. A shape the validator can reject exhaustively.

```jsonc
{
  "version": 1,
  "trigger": {
    "event": "message.created"        // must be in FLOW_EVENTS
  },
  "when": [                            // ALL must hold. No OR in v1. No nesting.
    { "field": "data.content", "op": "contains", "value": "deploy failed" },
    { "field": "channelId",    "op": "equals",   "value": "<uuid>" }
  ],
  "steps": [                           // ordered, max 5
    { "action": "post_message",
      "channelId": "<uuid>",
      "text": "Heads up — {{data.senderName}} reported a failed deploy." }
  ]
}
```

**Fields** are a fixed allowlist of dotted paths into the projected event record
produced by `publicFlowEventRecord` — `data.content`, `data.title`,
`data.senderKind`, `channelId`, `workspaceId`, `type`. Not a path expression:
a `Map` from the allowed string to a reader function. An unknown field fails
validation at write time.

**Ops**, v1: `equals`, `not_equals`, `contains`, `not_contains`, `starts_with`,
`is_empty`, `is_not_empty`. String and boolean only. No numeric comparison, no
regex (a user-supplied regex on user-supplied content is a ReDoS primitive), no
`in`. If this proves too thin, `matches_any` over a literal list is the next
addition — still not a language.

**Interpolation** in step strings is `{{field}}` against the same allowlist, with
the substituted value length-capped and never used to build a URL, a SQL fragment,
or an identifier. It substitutes into message bodies and task titles only.

**Actions**, v1 — three, chosen because each already has a safe, tested server-side
implementation to call:

| action | calls | bound already in place |
|---|---|---|
| `post_message` | the same insert + `notifyDbSubscribers` path used everywhere | none needed; cheap |
| `create_task` | the tasks insert | none needed; cheap |
| `dispatch_agent` | **`continueConversation`** (never a direct `agent_jobs` insert) | one-active-job unique index, `max_agent_turns`, reply cadence, conversation lock (`server/index.cjs:5042-5069`) |

That third row is the important one. `dispatch_agent` **must** go through
`continueConversation` so it inherits every bound the chat path already has. An
automation that inserted `agent_jobs` directly would bypass the turn budget and the
one-active-job index simultaneously, which is how one event becomes an unbounded
agent loop.

### 4.3 Cycles — the failure mode that matters most

The obvious one: an automation triggers on `message.created` and its step is
`post_message`. Its own post is a `message.created`. Unbounded, immediately,
and it bills a real model call each hop if the step is `dispatch_agent`.

Four independent brakes, because any single one can be defeated by a two-automation
cycle (A posts, B triggers on A and posts, A triggers on B):

1. **Self-exclusion.** A run never triggers itself. Same shape as the existing
   check at `server/index.cjs:6425-6429`.
2. **Depth.** Every row an automation writes is tagged with the producing run's id.
   The matcher reads that tag, sets `depth = producing.depth + 1`, and **refuses to
   enqueue above `AUTOMATION_MAX_DEPTH` (2)**. This is the one that stops A↔B,
   because depth is carried by the *data*, not by the automation identity.
3. **Per-automation rate limit.** `AUTOMATION_MAX_RUNS_PER_MINUTE` (10), counted
   from `automation_runs` — persisted, so it holds across Fly machines and
   restarts, unlike the in-memory limiters in `server/index.cjs`.
4. **Runaway auto-disable.** Exceeding the rate limit N times in a row sets
   `enabled = false` and writes `disabled_reason`. Trips loudly (an activity event),
   and a human must re-enable. An automation that a rate limit merely *throttles*
   is one that keeps costing money forever.

Brake 2 needs a tag column on every table an action can write. v1 writes only
`messages` and `tasks`, so it is two columns: `messages.automation_run_id` and
`tasks.automation_run_id`, both nullable uuid, both `ON DELETE SET NULL`. That is
a schema change to two hot tables and is the single largest cost in this plan —
worth naming as such. It is additive and nullable, so it is safe, but it is three
places twice.

### 4.4 Fan-out and throughput

- One event can match many automations. Bounded at
  `AUTOMATION_MAX_MATCHES_PER_EVENT` (10). Beyond that, log and drop — with the
  drop recorded, not silent.
- **Enqueue is a row insert, never an execution.** The realtime chokepoint must
  stay fast; it already fire-and-forgets `enqueueFlowWebhookEvents`.
- **Drain: one run per 1s tick**, a sibling of `flowDeliveryWorker`
  (`server/index.cjs:7570`) with the same in-flight boolean. Not the 30s tick:
  "when a task is created, post to #urgent" arriving 30s late reads as broken.
  Not merged into `flowDeliveryWorker`: a slow automation must not delay a
  webhook.
- **Steps within a run are serial**, and the run is claimed with the same
  lease + `claim_token` compare-and-set as `claimFlowWebhookDelivery`
  (`server/index.cjs:6471`), so two Fly machines cannot both run it.
- **Retries** reuse `flowWebhookRetryDecision`'s classification and backoff shape.
  A step that fails for a permanent reason (agent deleted, channel gone)
  dead-letters immediately rather than retrying eight times.
- **No loops, no fan-out steps, no parallel steps, no `for_each` in v1.** Steps are
  a fixed-length array, max 5. There is no construct in the definition that can
  produce a variable number of actions. This is why the engine cannot spawn
  unbounded agent jobs *by construction*, and the brakes in §4.3 exist only to
  handle cycles through the *data*.

### 4.5 Where definitions live, and who may edit

**A table, `automations`.** Explicitly not the two alternatives:

- **Not `documents`.** `documents` is `DEFAULT_TABLE_ACCESS`
  (`shared/backend-core.cjs:186`) — insert/update at `write`. Storing automations
  as documents would let any `editor` author a `dispatch_agent` step, which is a
  clean escalation from `write` to something strictly stronger than `run_agents`.
- **Not repo files.** The server has no repository. `workspaces.local_path` /
  `git_root` (`server/index.cjs:761-763`) describe the **daemon's** disk, not the
  Fly machine's. A server-side executor cannot read them, and routing definitions
  through the daemon would make automations stop working whenever an agent is
  offline — the opposite of what automation is for.

**Who may edit:** `manage` for create/update/delete/enable/disable, `read` for
list and run history. Rationale in §3.4.

### 4.6 Disabled by default

A newly created automation has `enabled = false`. The author enables it explicitly
after reading the rendered YAML. A definition that starts live means the first
thing a mistyped condition does is fire on everything, and the author finds out
from the channel rather than from the form.

---

## 5. Work breakdown

### Files to create

| File | Why |
|---|---|
| `shared/flow-events.cjs` | `FLOW_EVENTS`, `FLOW_EVENT_BY_CHANGE`, `publicFlowEventRecord`, `flowEventLocation` **moved** out of `server/index.cjs:6345-6401` and `server/flow-integration.cjs:11-23`. One vocabulary, two consumers. Pure; no db. |
| `shared/automation-rules.cjs` | Pure: field allowlist + readers, op implementations, `evaluateConditions`, `interpolate`, `validateDefinition`, `renderDefinitionYaml`. No db, no clock, no network — unit-testable in isolation, like `shared/replyCadence.cjs`. |
| `server/automations.cjs` | `createAutomations(deps)` factory in the `createThreadHarvest` shape: `matchAutomations`, `enqueueAutomationRuns`, `claimAutomationRun`, `runOneAutomation`, `runDueAutomations`, `sweepAutomationRuns`, plus `listAutomations`/`createAutomation`/`updateAutomation`/`deleteAutomation` and `mountAutomationRoutes`. All deps injected. |
| `tests/automation-rules.test.cjs` | Pure evaluator + validator + YAML renderer. |
| `tests/automations.test.cjs` | Matcher, enqueue idempotency, claim, cycle brakes, RBAC. |
| `tests/unit/automationsView.test.ts` | Frontend view logic. |
| `src/components/windows/AutomationsWindow.tsx` | The list + editor. Mirrors `SchedulesWindow.tsx`. |
| `src/hooks/useAutomations.ts` | Mirrors `useSchedules.ts`. |
| `supabase/migrations/<UTC>_automations.sql` | Migration lane of the three-place rule. |

### Files to modify

| File | Change |
|---|---|
| `server/index.cjs:6345-6401` | Delete the moved functions; `require` them from `shared/flow-events.cjs`. Behaviour-identical. |
| `server/index.cjs:754` `ensureRuntimeSchema` | The DDL from §4.1, plus `messages.automation_run_id` and `tasks.automation_run_id`. |
| `server/index.cjs:~7096` | `mountAutomationRoutes(app, { ...coreDeps(), ... })`. |
| `server/index.cjs:7567` | Add `void sweepAutomationRuns()` to the 30s tick (lease recovery + dead-letter). |
| `server/index.cjs:7570` | Add the sibling 1s `automationWorker`; clear it in the `server.on('close')` handler at `:7578`. |
| `server/realtime.cjs:228` | One added fire-and-forget `enqueueAutomationRuns(table, eventType, rowList)` next to the existing flow enqueue, same catch-and-log posture. |
| `server/flow-integration.cjs:11-23` | Re-export `FLOW_EVENTS` from the shared module so no existing importer changes. |
| `shared/backend-core.cjs` | `automations` + `automation_runs` into `ALLOWED_TABLES` (`:31`), `WORKSPACE_SCOPED_TABLES` (`:160`), `DB_TABLE_ACCESS` (`:186`, read-only-to-client shape with the justification comment the neighbours all carry), `JSON_COLUMNS_BY_TABLE` (`:115`, `definition`/`payload`/`steps`). |
| `server/mcp.cjs` | `list_automations`, `create_automation`, `set_automation_enabled` + `TOOL_SCOPES` entries. |
| `server/flow-integration.cjs:46` `TOOL_SCOPES` | `automations:read` / `automations:write` for the three tools; `automations:write` in `WORKSPACE_SCOPES` only, never `CHANNEL_SCOPES`. |
| `database/neon-schema.sql` | Canonical lane. |
| `src/types/index.ts:272,274` | `'automations'` added to `ActiveView` and `FloatingWindowType`. |
| `src/App.tsx` | Lazy import (~`:159`), open handler (~`:1340`), render branch (~`:3588`), switcher entry (~`:1927`). |
| `src/components/layout/Sidebar.tsx` | Entry point. |
| `AGENTS.md` | A short subsection: what an automation is, how an agent creates one, and the deploy lane. |

### Build sequence

**Step 1 — vertical slice (no UI, no YAML, no frontend).**
`shared/flow-events.cjs` extraction + its parity test. `shared/automation-rules.cjs`
with `equals`/`contains` and `post_message` only. `automations` +
`automation_runs` DDL in all three places. `server/automations.cjs` with match →
enqueue → claim → run → settle. Realtime hook. 1s worker. Two routes (list,
create). Self-exclusion + depth brake.
**Demonstrable end to end:** POST an automation, post a matching message, see the
automation's message appear, and see the run row. Ships alone if needed. **~2 days.**

**Step 2 — safety.** Rate limit, runaway auto-disable, lease sweep + dead-letter,
`created_by` role re-check at run time, the fan-out cap. Every brake gets its own
test with a named mutation. **~1.5 days.**

**Step 3 — the other two actions.** `create_task`, `dispatch_agent` via
`continueConversation`. `tasks.automation_run_id`. Remaining ops. **~1 day.**

**Step 4 — routes + MCP.** Update/delete/enable, run history, the three MCP tools,
YAML *rendering* on the read route. **~1 day.**

**Step 5 — frontend.** `AutomationsWindow`, `useAutomations`, window registration,
sidebar. Editor is a structured form (trigger select, condition rows, step rows)
with the rendered YAML shown read-only beside it. **~2 days.**

**Step 6 — docs.** `AGENTS.md` section + acceptance check "docs mention how
agents/humans use it". **~0.5 days.**

---

## 6. Test plan

**Runner globs, and they are load-bearing:**
- Backend: `npm test` → `node --test tests/*.test.cjs` (`package.json:15`). **Top
  level only — not recursive.** A file at `tests/automations/foo.test.cjs` never
  runs.
- Frontend: `npm run test:unit` → vitest, `include: ['tests/unit/**/*.test.ts']`
  (`vitest.config.ts`). A `.tsx` file never runs. A test outside `tests/unit/`
  never runs.

**Do not write a mock db that restates the SQL.** The house failure here is a fake
whose `unsafe()` re-implements the WHERE clause, so the test passes against the
mock's logic rather than the code's. Where the invariant lives in SQL (the claim,
the unique index, the partial index), the honest test asserts the **emitted SQL
text** contains the guard, and pairs with a same-file assertion that the
JS-level guard also holds. Where the invariant lives in JS, test the JS with a
db fake that returns fixed rows and records calls.

### Invariants and the mutation that must break each

`tests/automation-rules.test.cjs` (pure):

| # | Invariant | Mutation that must fail the test |
|---|---|---|
| I2 | `validateDefinition` rejects an unknown `field` | add a `default: readAnything` fallback to the field map |
| I3 | `validateDefinition` rejects an unknown `action` | replace the action allowlist check with a truthiness check |
| I4 | `validateDefinition` rejects >5 steps and >10 conditions | raise either cap |
| I5 | `when: []` matches everything; `when` with one failing clause matches nothing (AND, not OR) | change the `every` to `some` |
| I6 | `interpolate` leaves an unknown `{{token}}` literal and never throws | make the unknown path return `undefined` and stringify it |
| I7 | interpolated values are length-capped | remove the `.slice()` |
| I8 | the YAML renderer round-trips a definition to a stable string and quotes anything ambiguous | remove the quoting of a value like `on` or `1.0` |

`tests/automations.test.cjs` (worker, fake db):

| # | Invariant | Mutation that must fail the test |
|---|---|---|
| I1 | `FLOW_EVENT_BY_CHANGE` contains exactly the 10 documented pairs, and `FLOW_EVENTS` exactly the documented names + `REACTION_FLOW_EVENTS` | delete any entry from the extracted shared module |
| I9 | a disabled automation is never enqueued | drop `WHERE enabled` from the matcher query (assert on emitted SQL **and** on the JS filter) |
| I10 | an automation is never triggered by a row its own run produced | remove the self-exclusion check |
| I11 | enqueue at `depth >= AUTOMATION_MAX_DEPTH` inserts nothing | raise the constant, or move the check after the insert |
| I12 | two enqueues for the same `(automation_id, event_id)` produce one run | drop the `ON CONFLICT DO NOTHING` |
| I13 | `runDueAutomations` claims with a compare-and-set and a lease token; a second claimer gets nothing | change the claim to a bare `SELECT` then `UPDATE` |
| I14 | a run whose settle-UPDATE matches zero rows still returns a result (row hard-deleted mid-run) | make `finishRun` return `rows[0]` unguarded — the `thread-harvest.cjs:337` lesson |
| I15 | exceeding the per-minute rate limit skips the run and, on repeat, sets `enabled=false` with a `disabled_reason` | make the limiter throttle without ever disabling |
| I16 | `dispatch_agent` calls the injected `continueConversation` and never inserts `agent_jobs` | swap the step to a direct job insert — the test asserts the injected `continueConversation` seam was called and no job-insert SQL was emitted |
| I17 | a run whose `created_by` no longer holds `manage` does not execute a `dispatch_agent` step | delete the run-time role re-check (the create-time check alone must not satisfy it) |
| I18 | fan-out beyond `AUTOMATION_MAX_MATCHES_PER_EVENT` drops with a recorded reason | remove the cap |
| I19 | create/update/delete routes call `enforceWorkspaceRole(..., 'manage')`; list calls `'read'` | change any to `'write'` |
| I20 | `automations` and `automation_runs` carry the read-only-to-client `DB_TABLE_ACCESS` shape | change `insert` to `'write'` — assert the literal map in `shared/backend-core.cjs`, in the style of `tests/backend-rbac.test.cjs` |
| I21 | a step that fails permanently dead-letters instead of retrying to the cap | make every failure retryable |

`tests/unit/automationsView.test.ts`: the form→definition JSON builder produces
only definitions `validateDefinition` accepts (import the shared validator
directly), and the disabled-reason banner renders when `disabled_reason` is set.

**Two existing suites to re-run and not break:** `tests/flow-integration.test.cjs`
(the extraction must be behaviour-identical) and `tests/backend-rbac.test.cjs`
(new table entries).

---

## 7. Migration and rollout

**Data migration: none.** Four new tables/columns, all additive, all with
defaults. No backfill. No existing row is read differently.

**Reversibility.** Fully reversible up to the point anyone creates an automation.
Rollback is `enabled = false` for every row (one UPDATE), then reverting the
deploy. The two nullable columns on `messages` and `tasks` can be left in place
harmlessly. `DROP TABLE automations CASCADE` destroys user-authored definitions
and should not be the rollback path — **disable, do not drop.**

**Deploy lanes** (`AGENTS.md`, and the deploy-targets rule):
- **`fly deploy` — required.** `server/index.cjs` (DDL + wiring),
  `server/realtime.cjs`, `server/automations.cjs`, `server/mcp.cjs`,
  `shared/backend-core.cjs`. Nothing works until this runs. `ensureRuntimeSchema`
  executes on Fly boot; check the logs after, per the standing rule that a lagging
  Fly hides broken SQL.
- **Netlify — required for step 5** (`src/**`, auto-deploys on push).
- **npm publish of `@agensis/agensis-agent` — not needed.** No daemon change.
- **Local daemon restart — not needed.**

**Order: Fly first, then Netlify.** A frontend that ships ahead of the backend
calls routes that 404 live — the repeated failure in this repo's history.

**Feature flag.** `AGENSIS_AUTOMATIONS` (default `'0'` on first deploy). When off:
the realtime hook returns immediately, the 1s worker never arms, and the routes
return 404. Gate the *worker and the enqueue*, not just the UI — a flag that only
hides a button still runs automations.

**Staged rollout.** Fly with the flag off → confirm the `flow-integration` suite
and live webhook deliveries still work after the extraction → flag on for one
workspace → watch `automation_runs` for a day → default on.

---

## 8. Risks, effort, and what I would not build

### Ranked risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| R1 | **Runaway loop bills real money.** Two automations that trigger each other, each dispatching an agent. Not hypothetical: `channel_bridges` means an inbound Telegram message is a `messages` INSERT. | **Critical — cost** | Four independent brakes (§4.3), the strongest being depth carried by the data. Auto-disable, not throttle. Ship §5 step 2 before enabling for anyone. |
| R2 | **Privilege escalation via a forged row.** A `write`-role user inserting into `automations` through `/backend/db/insert` gets an agent-dispatch primitive. | **Critical — security** | Read-only-to-client `DB_TABLE_ACCESS` + `manage` on every dedicated route. I20/I19 pin both, with the mutation named. |
| R3 | **Stale authority.** An automation created by a since-demoted or removed admin keeps dispatching agents. | **High — security** | Re-check `created_by`'s role at run time, not create time (I17). Easy to omit; it is the control most likely to be dropped under time pressure. |
| R4 | **The `FLOW_EVENT_BY_CHANGE` extraction silently drops an entry**, killing a live customer's outbound webhook. | **High — regression** | I1 asserts the literal expected set. Extraction is a move with no edits in the same commit. |
| R5 | **`dispatch_agent` bypasses the turn budget.** A future refactor "optimises" it into a direct `agent_jobs` insert. | High — cost | I16 asserts the `continueConversation` seam is used and no job-insert SQL is emitted. A comment at the call site saying why. |
| R6 | **Two automation systems forever.** Event automations and `agent_schedules` both live indefinitely; new work has to ask which one to extend. | High — architectural | §3.3's convergence order, with v2 (`schedule` trigger, delete `runDueSchedules`) committed to before v1 ships. If the team will not commit, do not build. |
| R7 | **`automation_run_id` on `messages`** — a hot, large table getting a new column. | Medium — operational | Nullable with no default and no index in v1; `ADD COLUMN` of a nullable column with no default is metadata-only on modern Postgres. Verify on the real Neon instance before the Fly deploy, not after. |
| R8 | **The condition language grows into a language.** "Just add OR", then nesting, then arithmetic, then a sandbox. | Medium — scope | The ops list is a closed allowlist in one pure module with a test that enumerates it. Any addition is a visible diff to that list. |
| R9 | **YAML rendering drifts from the JSON** and shows a user something that is not what runs. | Medium — correctness | The renderer is pure and tested for stability (I8). It is display-only; nothing parses it back in v1. |
| R10 | **The 1s worker becomes a hot loop** against Postgres when the queue is empty. | Low — operational | Same query shape and same cadence as the shipped `flowDeliveryWorker`, which has been fine. Single indexed query returning zero rows. |

None of these can cause **data loss** — every action is additive, and nothing in
this design deletes or overwrites a user row. R1/R5 are cost; R2/R3 are security.

### Effort

**7–8 engineer-days** for all six steps, **medium-high confidence**. The vertical
slice (step 1) alone is **2 days** at high confidence — it is a close structural
copy of `thread-harvest.cjs` plus a matcher.

**The biggest unknown is R7.** Adding `automation_run_id` to `messages` on the
production database is the one operation whose cost I cannot predict from reading
the code — I do not know the row count on the live Neon instance, and I was asked
not to run anything against it. If `messages` is large enough that this is a
concern, there is a fallback that avoids the column entirely: store the produced
row ids on the run (`automation_runs.produced_ids uuid[]`) and have the matcher
check membership. That is a slower lookup per event and needs
`ARRAY_COLUMNS_BY_TABLE` handling in both backends (`AGENTS.md:36-38`), which is
why it is the fallback and not the default — but it removes the only risky DDL in
the plan.

Second unknown: whether `tasks` should be added to `FLOW_EVENT_BY_CHANGE`. "When a
task is created" is the automation everyone will ask for first, and `tasks` is
absent from the map today. Adding it also widens the **outbound** webhook surface
for every existing Flows connection — an existing integration would start receiving
a new event type it never subscribed to. `normalizeEvents`
(`server/flow-integration.cjs:82`) filters to what a connection subscribed to, so
existing connections are safe; but this needs confirming against a live connection
before it ships, not asserted from a read.

### Deliberately NOT in v1

- **No YAML parsing.** Render only. No parser dependency.
- **No import/export of definitions between workspaces.** Needs the parser.
- **No `schedule` trigger.** That is the v2 convergence with `agent_schedules`.
- **No `webhook` trigger.** v3.
- **No outbound HTTP action.** `flow_connections` already does this properly.
- **No loops, `for_each`, branches, parallel steps, or step-to-step data flow.**
  A step reads the trigger event, not the previous step's output.
- **No OR, no nesting, no regex, no numeric comparison** in conditions.
- **No template language.** `{{field}}` against an allowlist, into message bodies
  and task titles only.
- **No version history or diffing of definitions.** `documents` has
  `document_versions`; automations do not get that in v1.
- **No dry-run / test-fire button.** Wanted, and genuinely useful, but it needs a
  synthetic event payload builder that is its own piece of work.
- **No cross-workspace automations.** Workspace-scoped, full stop.
- **No editing another user's automation below `manage`.** No sharing model, no
  per-automation ACL — workspace role is the whole permission story.
