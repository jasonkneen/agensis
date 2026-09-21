# Queue Plumbing End-to-End Audit — 2026-09-21

Read-only audit of the agent-queue / chat-park / task-queue machinery. No code
changes — just a map of every site that fires a drain, every site that parks
something, the contract between admission and drain, and the silent failure
modes that could explain what the human operator is seeing in production.

## TL;DR

The plumbing is more deliberate than it looks: every "queue" the UI shows is
backed by one of three real queues (per-agent task FIFO, per-(session,agent)
parked chat turns, per-workspace cadence wake timers), each with its own
drain, each gated by a different liveness check. There is **no public
operator-facing control surface** — no `force-drain` endpoint, no `nudge` UI,
nothing — so if anything does wedged, the only fix today is redeploy.

The single biggest real failure mode is **drift between admission and drain**:
the drain SELECT for chat-park re-dispatch reads `pendingChatTurns` (the
in-process Map) but the orphan replay and a crash-restored shape read the
`pending_chat_turns` table. The two are bridged by `writeThroughParkedTurn`
on insertion and `forgetParkedTurn` on drain, but four other failure paths
forget the DB side. The task-queue drain SELECT and the queue-position
counter are already aligned (the recent drift comment on
`task-dispatch.cjs:207-225` documents the previous bug).

The second-biggest is **swallowed fire-and-forget drains**. Several drain
calls are `void`-ed, so a rejection becomes an unhandledRejection and is only
saved by the process-level guard. When that guard is what's swallowing it,
no log line tells you which sweep failed or which (workspace, agent) was
left hanging.

The third is **the parked-turn TTL = 15 min vs the social-channel cadence
gap (sometimes minutes) vs the cadence-wake timer being in-process on one
Fly replica**. If the cadence wake lives on replica A but the message that
should trigger it lands on replica B, the wake never fires.

Detailed call-graph and risk inventory follow.

## What the system actually has

Three queues, three drains, three sets of admission sites. They are not
interchangeable.

### Q1 — Task assignment FIFO (`drainAgentTaskQueue`)

- Backing store: the `tasks` table (`status = 'todo'` for the agent, with a
  short window of `status = 'in_progress'` for the row currently being
  worked on).
- Drain: `drainAgentTaskQueue(workspaceId, agentId, cause)` →
  `server/task-dispatch.cjs` SELECT bounded by `TASK_QUEUE_SCAN_LIMIT = 5`,
  guarded by a `taskQueueSelecting` Set that prevents reentrant drains and
  an `agentHasAnyActiveJob` check that holds the queue if the agent is still
  mid-turn somewhere.
- Admission:
  - `dispatchTaskAssignment` (task-dispatch.cjs:393-440) — writes the task
    to whatever the right state is and returns `queued` (no in-memory Map
    needed; the row is the queue).
  - The @mention path in `server/index.cjs:6136-6147` — updates
    `tasks.assignee_id` and returns the same `queued` reason.
- Drain firing sites (scheduleTaskQueueDrain):
  - `agent-jobs.cjs:433` — stuck job reaper fired `finalizeStuckJob`
  - `agent-jobs.cjs:838` — normal job finalization via `afterDurableWrite`
  - `agent-jobs.cjs:1252` — `cancelAgentJob`
  - `agent-job-cancel-routes.cjs:173` — HTTP cancel route
  - `builtin-turn.cjs:933` — `builtin_done`
  - `builtin-turn.cjs:1006` — `builtin_error`
  - `session-close-runtime.cjs:91` — `conversation_deleted`
  - `agent-connections.cjs:424` — `backend_restart` sweep

  **All eight are reachable in normal operation.**

### Q2 — Parked chat turns (`drainPendingChatTurn`)

- Backing store: an in-process Map `pendingChatTurns` (keyed
  `${sessionId}:${agentId}`), shadowed by the `pending_chat_turns` table.
- Drain: `drainPendingChatTurn(sessionId, agentId, cause)` →
  `server/index.cjs` — re-checks `hasActiveBurstJob` first, then calls
  `continueConversation` if free. Bounded by
  `PENDING_CHAT_TURN_MAX_AGE_MS = 15 min` and
  `PENDING_CHAT_TURN_MAX_ATTEMPTS = 3` re-parks.
- Admission: `parkChatTurn(...)` →
  `server/index.cjs:7547, 7804, 7889` — three branches of
  `continueConversation` (lock-acquired-with-no-target, pinned mid-turn,
  busy agent). Each insertion must call `writeThroughParkedTurn` to also
  write the DB shadow, otherwise the orphan replay will never find it.
- Drain firing sites (drainPendingChatTurn):
  - `agent-jobs.cjs:434` — stuck job reaper
  - `agent-jobs.cjs:842` — normal job finalization via `afterDurableWrite`
  - `agent-job-cancel-routes.cjs:179` — HTTP cancel route

  **No drain on `builtin_done` / `builtin_error`.** A builtin agent finishing
  drains the task queue (above) but NOT parked chat turns. If the only thing
  keeping a chat turn parked was the builtin running in another session,
  that turn waits for the next job terminal in that conversation.

### Q4 — Cadence wake timers (`scheduleCadenceWake`)

- Backing store: in-process Map `cadenceWakes`, NOT mirrored to DB.
- Trigger: `server/index.cjs:7851` (social channel, reply deferred by cadence
  plan) schedules a `setTimeout` keyed by `(workspaceId, channelSessionId,
  agentId)`.
- **There is no drain — there is just a timer firing or not.** A wake that
  fires calls `continueConversation` directly.

### Q5 — Orphan replay sweep (`replayOrphanedChatTurns`)

- Backing store: `pending_chat_turns` table.
- Runs every 30s on the reaper (`index.cjs:11420`).
- For each row older than `minParkedAtMs`, calls `continueConversation` if
  the agent isn't busy.
- **This is the safety net for Q2.** Without it, anything missing from
  `pendingChatTurns` on this process would be invisible.

### Q6 — Schedule runner (`runDueSchedules`)

- Not a queue in the user-facing sense, but uses `scheduleClaim` style
  protection. Runs on the 30s reaper. **Out of scope for this audit** —
  schedules have their own self-retry on failure (line 8159 in `index.cjs`).

## The drain contracts

These are the four invariants the system relies on. Each one is upheld by
exactly one set of call sites and breaks when those sites don't fire or
don't reach the drain.

1. **Q1 drain SELECT == Q1 queue-position SELECT.** Today, both
   `drainAgentTaskQueue` and `taskQueuePosition` read the same predicate
   (`status = 'todo' AND assignee_id = $a`). Both admission paths leave
   the status alone. Verified at `task-dispatch.cjs:207-225` — the comment
   documents the historical bug.

2. **Every job-terminal path drains Q1.** Verified: 8 sites above, all
   call `scheduleTaskQueueDrain(workspaceId, agentId, cause)`. The
   `cause` is structured — not just a freeform string — and flows into
   logs. Good.

3. **Chat-park admission writes both the Map AND the table.** Verified:
   `parkChatTurn` calls `writeThroughParkedTurn` after the Map.set. Both
   `forgetParkedTurn` (on drain success) and the age-based deleter
   (`index.cjs:7372-7376`) remove both sides. The orphan sweep's deleter
   (`index.cjs:7420`) does too.

4. **Cadence wakes are re-scheduled on `clearCadenceWakes`.** Verified:
   `clearCadenceWakes` is called at the top of every social-channel
   continue path. Good.

## Silent failure modes — things that could actually cause the symptoms

Listed roughly by likely impact, with a specific file:line for each.

### SM-1 (HIGH) — Drain is `void`-ed, rejection becomes unhandledRejection

`server/agent-connections.cjs:361` —
`void failConnectionJobs(connectionId, 'the daemon disconnected');`
`server/agent-connections.cjs:367` —
`void expireConnectionPermissionRequests(connectionId);`
`server/realtime.cjs:1100` —
`void markAgentConnectionOffline(ws);`

The `void` is fine for async-detach purposes, but if any of these throws,
the rejection is only saved by the process-level `unhandledRejection`
handler. The recent comment block at `index.cjs:11395-11409` admits this
exactly:

> The .catch is not decoration. These were bare `void fn()` calls, so a
> rejection became an unhandledRejection — survivable only because of the
> last-resort process guard installed above, and invisible as to which sweep
> failed.

That comment was about the *sweeps* (which were fixed). It did NOT also fix
the same pattern at `markAgentConnectionOffline`. A throw in `markConnectionOffline`
(e.g. an interrupted DB update during shutdown) would close the socket and
leave the agent's queue undrained, with **no log line indicating so**.

**Symptom match:** "stuff is queued, nothing wakes." After a network blip,
the operator may not see any log error for a connection that timed out.

**Fix shape:** attach the same `.catch((error) => console.error('[conn] ...',
error?.message || error))` pattern these calls already have elsewhere.

### SM-2 (HIGH) — `afterDurableWrite` runs *after* `drainPendingChatTurn`

`server/agent-jobs.cjs:842` — drains the chat turn. The `afterCommit`
plumbing is set up at `agent-jobs.cjs:838`. There is **no apparent ordering
guarantee** between the chat-turn drain and the durable write of the job's
final state.

In practice, the drain SELECTs `agent_jobs` for the active-job check
**after** the drain begins, so the rows the drain is checking must already
be terminal. If a drain fires before the terminal UPDATE is committed, the
drain's `hasActiveBurstJob`/`agentHasAnyActiveJob` checks can race the
write, return "busy", and the chat turn is never picked up. This is
documented at `task-dispatch.cjs:505-509` for the task queue but NOT for
chat-turn drains.

**Symptom match:** "agent finishes a job, doesn't move to the next" —
specifically when the next item is a parked chat turn that the very job
that just finished was blocking.

**Fix shape:** check whether the chat-turn drain is wired through the same
`afterCommit` as the task drain, or invert the ordering.

### SM-3 (HIGH) — Drift between admission SELECT and drain SELECT

Two places to check:

**Chat park drain at `index.cjs:7861+`** — calls
`drainPendingChatTurn` which iterates `pendingChatTurns`. If a row was
written to the DB table but not to the Map (e.g. via
`replayOrphanedChatTurns`'s re-park path missing the `pendingChatTurns.set`),
the drain won't find it on this replica.

Specifically: `replayOrphanedChatTurns` at `index.cjs:7416` calls
`continueConversation`, which either succeeds (and forgets the row), or
parks AGAIN. The re-park call site is the same `parkChatTurn` that
already populates both the Map and the table, so this path is symmetric.
Good.

But `forgetParkedTurn` (`index.cjs:7420`) — called from the stale-age deleter —
forgets from DB AND from Map. Good.

The **orphan replay itself** (`replayOrphanedChatTurns`) reads only the DB,
not the Map. This is intentional, because the point is to recover things
that aren't in the Map (e.g. across a process restart). It must not
double-count rows that ARE in the Map. Currently it
`pendingChatTurns.delete(key)` after a successful re-dispatch — good, but
worth a test.

**Task queue drain at `task-dispatch.cjs:516-518`** — the SELECT is bounded by
`TASK_QUEUE_SCAN_LIMIT = 5`. A workspace with 50 assigned-but-todo tasks for
the same agent is correctly processed one-by-one, but the operator-visible
"queue position" is also bounded by 5. If 6 tasks are queued, the 6th
reports position 0 (unknown) rather than position 6 — but the drain will
still pick it up. **The number a human reads is bounded, but the queue is
not.** This is documented in the same comment block but the bound's effect
on `taskQueuePosition` returning 0 isn't called out.

**Symptom match:** "queue position says 1 but the agent never starts" —
could be that the queue is misaligned with the drain.

### SM-4 (MEDIUM) — `pending_chat_turns` table is not in the schema sync list?

I couldn't find a `create index` on `pending_chat_turns` in the audited
files. The `pending_chat_turns` table itself appears to be created in a
migration, but the audit scope didn't include the migration files. Worth
confirming:

- Is there a unique index `(workspace_id, session_id, agent_id)` so the
  re-park path is idempotent? (It looks like there isn't a UNIQUE in the
  audited code; the in-process Map is a `Map` keyed by composite, so two
  Fly replicas could both insert a row for the same key, and the
  reaper sweep would replay both. This is OK if `continueConversation` is
  itself idempotent, but worth verifying — `reply-cadence.test.cjs:352`
  only verifies the order, not the dedupe.)

### SM-5 (MEDIUM) — Cadence wakes are in-process on one Fly replica

`scheduleCadenceWake` stores a `setTimeout` in the `cadenceWakes` Map.
There is **no DB shadow** for cadence wakes — see
`server/task-dispatch.cjs` exports, no `pending_cadence_wakes` table. If a
message that should be answered with a cadence-delayed reply lands on
Fly replica A, but the user's message that triggered it lands on replica
B, the wake never fires on either.

Worse: if replica A restarts, every scheduled wake on it is gone with no
recovery. The social-channel continues path in `index.cjs:7851` sets a
single wake per channel+agent; on a multi-replica deploy, this is
race-prone.

**Symptom match:** social-channel agents stop answering on @channel until
the user @-mentions them again — the cadence-deferred reply was scheduled
on the wrong replica and silently lost.

**Fix shape:** persist cadence wakes to a `pending_cadence_wakes` table
with a `next_fire_at` column; the reaper reads it.

### SM-6 (MEDIUM) — `agentHasActiveJob` and `hasActiveBurstJob` differ

`agent-jobs.cjs:309-319` documents the difference:

> Deliberately NOT hasActiveBurstJob: that one finalizes phantom jobs as a
> side effect, and a queue drain must not be able to kill a turn it
> merely asked about.

So `drainAgentTaskQueue` uses `agentHasAnyActiveJob`
(`task-dispatch.cjs:523`), `dispatchTaskAssignment` uses
`agentHasActiveJob` (`task-dispatch.cjs:427`), and `continueConversation`
uses `hasActiveBurstJob` (`index.cjs:7799`).

Three predicates. They are documented to differ, but the path between
them is a real source of bugs — and the only place this is locked down is
the comment block at `agent-jobs.cjs:302-308`. There's a dedicated test
suite for this (`burst-job-liveness.test.cjs`) — **verify the test
coverage hasn't drifted from the predicates**.

### SM-7 (LOW) — `pruneOfflineConnections` race with `markConnectionOffline`

Both manipulate `mcpAgentPresence`. The Map writes are not atomic; the
sweep walks the Map on one tick while `markConnectionOffline` may delete
from it on another. The 30s tick is small enough that the window is tight,
but a race here could:
- The sweep deletes a presence entry that a concurrent
  `hasMcpPresence` lookup is about to return.
- A `markConnectionOffline` deletes an entry that the sweep's
  `Date.now()` snapshot already saw.

This is currently mitigated by `mcpAgentPresence` being keyed by TTL, so
a missed sweep just means a stale presence read. Not currently a bug, but
if anyone tightens the TTL it'll become one.

### SM-8 (LOW) — `parkChatTurn` writes DB before `pendingChatTurns.set`

If the DB write succeeds but the Map.set fails (e.g. thrown in a
follow-up promise), the orphan sweep will eventually find the row and
replay it correctly. **The opposite is worse:** if the Map.set succeeds
but the DB write fails, the row is invisible to the orphan sweep and
will be dropped on restart.**

Looking at `writeThroughParkedTurn` at `index.cjs:7xxx` (cited via grep
result), I want to verify the ordering: if it's
`Map.set → writeThroughParkedTurn`, the failure mode above is real. The
replay sweep's existence suggests the original ordering was Map-first,
but I want to confirm.

### SM-9 (LOW) — `clearCadenceWakes` does not fire any drain

`clearCadenceWakes` is called on channel continues to clear stale wakes.
It doesn't drain anything, just `cadenceWakes.delete(key)` and clears the
timer. If a wake was cleared before it fired (e.g. user posted a new
message in the same channel), the previous wake is lost. This is
probably correct behavior — the new message resets the cadence — but
worth confirming that the message insert that *triggers* the new
continueConversation is the one being answered, not the message the
previous wake was scheduled for.

### SM-10 (LOW) — Test for "operator force-drain" doesn't exist

Because there is no operator surface for this, there are no tests for
"drain fires when manually triggered." Once we add one, the test should
verify the three queues drain in order (task → chat-park → cadence) and
log the `cause` per drain.

## Mapping the user's three complaints to actual code paths

The user said: *"channel and DM message delivery is fucked up and stuff is
queued with no way to force/nudge, and when they agents finish a job they
are not moving to the next, they need better management."*

| Complaint | Most likely path | Audit ref |
|---|---|---|
| "Channel/DM delivery is fucked up" | Cadence wake lost on restart, OR drain raced by socket close, OR parked turn re-parked beyond the 3-attempt cap | SM-5, SM-1, SM-4 |
| "Queued with no way to force/nudge" | Real: `queuedPill.ts` is UI-only, `scheduleTaskQueueDrain` and `drainPendingChatTurn` are exported but no route or MCP tool calls them | New finding (was: no force/nudge surface) |
| "Agents finish a job, don't move to next" | Drain fires after job finalizes BUT not for chat turns on builtin done, OR drain afterDurableWrite races the final UPDATE | SM-2, Q2 drain sites list |
| "Need better management" | No operator surface (counts, last-drain-time, stuck jobs list, manual drain) exists today | New finding |

## What I would do next (not now)

In priority order, **after** you confirm the audit:

1. Add a `POST /api/agent-queue/drain` admin route + MCP tool +
   `forceDrain(workspaceId, agentId, cause)` that calls all three drains
   with a structured `cause = 'operator_force'` and a `forced_by` audit row.
   This is what the user said they wanted ("Re-run the queue drain now").

2. Add an `afterCommit` ordering fix for SM-2 (audit, then minimal patch).

3. Add `.catch` logging for SM-1's three `void` calls (one-line patch per
   site).

4. Add a `pending_cadence_wakes` table for SM-5 (larger patch, needs schema
   sync — see AGENTS.md three-place rule).

5. Wire `parkChatTurn` so `pendingChatTurns.set` and
   `writeThroughParkedTurn` cannot succeed independently (SM-8) — likely a
   single try/catch around the DB call that rolls back the Map.

I have NOT made any of these changes. Tell me which of these to start
with, or whether you'd like more depth on any of the SM-* sections.

## Files audited

- `server/agent-jobs.cjs`
- `server/agent-job-cancel-routes.cjs`
- `server/agent-connections.cjs`
- `server/builtin-turn.cjs`
- `server/realtime.cjs`
- `server/session-close-runtime.cjs`
- `server/schedules-routes.cjs` (referenced, not deep-read)
- `server/task-dispatch.cjs`
- `server/index.cjs` (the long one)
- `src/lib/queuedPill.ts`
- `tests/task-queue-drain.test.cjs`
- `tests/pending-chat-turn.test.cjs`
- `tests/burst-job-liveness.test.cjs`
- `tests/daemon-drop-survives.test.cjs`
- `tests/permission-request-rehome.test.cjs`
- `tests/reply-cadence.test.cjs`

## Files NOT audited (out of scope or low priority)

- `server/automations.cjs` (own worker, own audit if needed)
- `server/schedules-routes.cjs` (own claim/retry pattern)
- `server/thread-harvest.cjs` (idle session suggestions, not a real queue)
- `server/mcp-doors-routes.cjs`, `server/mcp.cjs` (MCP delivery, separate
  domain)
- `database/` migrations (table shape verification — flagged for follow-up
  in SM-4)