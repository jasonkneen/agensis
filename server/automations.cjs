'use strict';

// ============================================================================
// server/automations.cjs
// ----------------------------------------------------------------------------
// Workspace automations: "when X happens inside agensis, do Y inside agensis",
// without a code change.
//
// THE CELL THIS FILLS. agensis already had three automation systems, each
// hardcoding one axis of the trigger/action matrix:
//
//   agent_schedules    time trigger      -> wake an agent    (runDueSchedules)
//   agent_webhooks     inbound HTTP      -> wake an agent    (agent-webhooks-routes)
//   flow_connections   workspace event   -> POST to a URL    (enqueueFlowWebhookEvents)
//
// Every one of them ends in either a paid model turn or an outbound HTTP
// request. The uncovered cell is event-triggered with an INTERNAL action, and
// that is the only thing this file adds. It is NOT a fourth general-purpose
// engine: it has one trigger kind, two actions, no loops, no branches and no
// step-to-step data flow, and none of the three existing systems is touched.
//
// RELATIONSHIP TO flow_connections, since the names are close. A flow connection
// is the OUTBOUND edge -- it already does signed delivery, idempotency keys,
// leases, retry classification and an SSRF guard, and re-implementing outbound
// HTTP here would create a second, less-tested SSRF surface reachable at
// `manage`. So automations have NO outbound action at all. "Event -> external
// URL" is a Flows connection, today, unchanged. The two share the event
// vocabulary (FLOW_EVENTS / FLOW_EVENT_BY_CHANGE, injected) and nothing else.
//
// WHY THERE IS NO dispatch_agent ACTION. An action that could start an agent
// turn is the difference between "an automation writes a row" and "an
// automation spends money in a loop". With no such action, unbounded agent-job
// fan-out is impossible BY CONSTRUCTION rather than bounded by a limiter that a
// later change could raise. post_message inserts a message and notifies
// subscribers; it does not call continueConversation, so it does not advance the
// conversation and wakes nobody -- the same semantics the MCP post_message tool
// already documents. An automation run therefore costs zero model calls. When
// dispatch_agent is added it MUST go through continueConversation (never a
// direct agent_jobs insert) so it inherits the one-active-job unique index, the
// max_agent_turns budget and the per-conversation lock, and the run-time
// re-check of the author's role becomes mandatory rather than advisory.
//
// create_task KEEPS THAT PROPERTY, and keeps it by shape. Task dispatch fires
// on a non-empty `assignee_id` inside the /backend/db/insert route -- not in a
// trigger -- so a direct INSERT takes neither path. On top of that the step has
// no assignee field at all: the validator rebuilds each step from `title` and
// `description` only, so no stored definition can carry one even if somebody
// writes it into the JSON. An automation creates the task; a human assigns it.
// Do not add an assignee field to make create_task "complete".
//
// House pattern: a createAutomations(deps) factory with every dependency
// injected, matching createThreadHarvest and createTaskDispatch, so the logic is
// testable against a fake db. Claim/settle is a compare-and-set with a lease
// token, so two Fly machines cannot both run one row.

const crypto = require('node:crypto');
const {
 evaluateConditions,
 interpolate,
 validateDefinition,
 renderDefinitionYaml,
 AUTOMATION_TASK_SOURCE_TYPE,
 MAX_TASK_TITLE_LENGTH,
} = require('../shared/automation-rules.cjs');

/**
 * How many runs one 30s tick may drain.
 *
 * Bounded for the same reason thread-harvest's drain is bounded to 3: this runs
 * on the shared reaper interval, and a backlog must not turn one tick into an
 * unbounded serial loop that stalls the job reapers behind it. The number is
 * higher than thread-harvest's because a harvest tick is a model call and an
 * automation step is a local INSERT -- the bound is chosen for what the work
 * costs, but the BOUND ITSELF is the invariant and must not be removed.
 */
const AUTOMATION_MAX_RUNS_PER_TICK = 20;

/**
 * How many automations one event may fan out to. Beyond this the extras are
 * dropped and the drop is RECORDED, never silent.
 */
const AUTOMATION_MAX_MATCHES_PER_EVENT = 10;

/**
 * Per-automation ceiling on runs enqueued in a rolling minute.
 *
 * Counted from automation_runs rather than an in-memory limiter, so it holds
 * across restarts and across Fly machines -- an in-process counter would reset
 * on the very deploy a runaway automation provoked.
 */
const AUTOMATION_MAX_RUNS_PER_MINUTE = 10;

/**
 * Consecutive rate-limit trips before the automation is DISABLED rather than
 * merely throttled. An automation a limiter only throttles is one that keeps
 * costing something forever and never asks anyone about it.
 */
const AUTOMATION_RUNAWAY_STRIKES = 3;

/** How long a claimed run may stay inflight before the sweep reclaims it. */
const AUTOMATION_LEASE_MS = 60_000;

/** Attempts before a run is dead-lettered instead of reclaimed again. */
const AUTOMATION_MAX_ATTEMPTS = 3;

/** The message sender_kind an automation posts under. See matchAutomations. */
const AUTOMATION_SENDER_KIND = 'automation';

function badRequest(message) {
 return Object.assign(new Error(message), { status: 400 });
}

function notFound(message) {
 return Object.assign(new Error(message), { status: 404 });
}

function createAutomations(deps = {}) {
 const {
  getDb,
  notifyDbSubscribers,
  enforceWorkspaceRole,
  // The event vocabulary, INJECTED rather than imported. It lives in
  // server/index.cjs (FLOW_EVENT_BY_CHANGE) and server/flow-integration.cjs
  // (FLOW_EVENTS) and drives live outbound webhooks; injecting it means this
  // feature reads the same map without a refactor that could silently drop an
  // entry and kill someone's shipped integration.
  flowEventByChange = {},
  flowEvents = [],
  // publicFlowEventRecord / flowEventLocation from server/index.cjs — the same
  // redacted projection the outbound webhook payload already uses.
  publicFlowEventRecord = () => ({}),
  flowEventLocation = async () => null,
  // The audit writer. Authoring an automation is a STANDING grant to write into
  // the workspace on an event, which is the same class of thing as an
  // agent_webhook, so create/update/delete/enable belong in the audit log.
  recordAudit = async () => null,
  onWarn = (message) => console.warn(`[automations] ${message}`),
  // Off by default: the enqueue hook and the worker both check this, so the
  // flag gates EXECUTION and not merely a button.
  isEnabled = () => String(process.env.AGENSIS_AUTOMATIONS || '0') === '1',
 } = deps;

 // Consecutive rate-limit trips per automation. In memory on purpose: it only
 // has to survive long enough to reach AUTOMATION_RUNAWAY_STRIKES, and the
 // durable half of the guard is the disabled_reason column it writes.
 const runawayStrikes = new Map();

 // ---------------------------------------------------------------------------
 // Matching and enqueue
 // ---------------------------------------------------------------------------

 /**
  * Which enabled automations in this workspace want this event?
  *
  * The query filters on `enabled` in SQL (the partial index) AND the caller
  * filters again in JS after evaluating conditions. Both matter: the SQL guard
  * is what keeps this cheap on a hot write path, and it is the one a careless
  * edit would drop.
  */
 async function matchAutomations(workspaceId, eventType) {
  const rows = await getDb().unsafe(
   `select id, workspace_id, name, enabled, trigger_event, definition, created_by
      from automations
     where workspace_id = $1 and trigger_event = $2 and enabled = true
     order by created_at asc
     limit $3`,
   [String(workspaceId), String(eventType), AUTOMATION_MAX_MATCHES_PER_EVENT + 1],
  );
  // Defence in depth: never trust the row's `enabled` to have been filtered.
  return rows.filter((row) => row.enabled === true);
 }

 /** Rolling-minute run count for one automation. */
 async function recentRunCount(automationId) {
  const rows = await getDb().unsafe(
   `select count(*)::int as count from automation_runs
      where automation_id = $1 and created_at > now() - interval '1 minute'`,
   [String(automationId)],
  );
  return Number(rows[0]?.count || 0);
 }

 /**
  * Trip the runaway guard: disable the automation and say why.
  *
  * Disabling rather than throttling is deliberate. A throttled runaway keeps
  * running forever at the limit and nobody is ever told; a disabled one stops
  * and demands a human look at it.
  */
 async function disableRunaway(automation, reason) {
  const rows = await getDb().unsafe(
   `update automations
       set enabled = false, disabled_reason = $2, last_status = 'runaway', updated_at = now()
     where id = $1 and enabled = true
     returning *`,
   [String(automation.id), String(reason).slice(0, 300)],
  );
  if (rows.length) {
   notifyDbSubscribers('automations', 'UPDATE', rows);
   onWarn(`automation ${automation.id} disabled: ${reason}`);
   await recordAudit({
    workspaceId: String(automation.workspace_id || ''),
    actor: { label: 'automation runaway guard' },
    action: 'automation.disabled',
    target: { type: 'automation', id: String(automation.id), label: String(automation.name || '') },
    before: 'enabled',
    after: 'disabled',
    detail: { reason: String(reason).slice(0, 200), automatic: true },
   });
  }
  runawayStrikes.delete(String(automation.id));
  return rows[0] || null;
 }

 /**
  * Queue runs for one realtime write. Called fire-and-forget from the realtime
  * chokepoint, so it must never throw into the caller's write path.
  *
  * ENQUEUE IS A ROW INSERT, NEVER AN EXECUTION. The chokepoint is on every
  * workspace write in the product and has to stay fast.
  */
 async function enqueueAutomationRuns(table, eventType, rows) {
  if (!isEnabled()) return [];
  const flowEventType = flowEventByChange[`${table}:${eventType}`];
  if (!flowEventType) return [];
  const queued = [];

  for (const row of Array.isArray(rows) ? rows : []) {
   // THE CYCLE BRAKE. A row an automation produced never triggers an
   // automation. post_message writes `messages` under sender_kind='automation',
   // so this single check makes chains impossible -- including the
   // two-automation cycle (A posts, B triggers on A and posts, A triggers on B)
   // that a per-automation self-exclusion check would miss.
   //
   // It is blunter than the depth counter the plan described, and deliberately
   // so: depth needs a tagging column on every table an action can write, which
   // for `messages` is a schema change to the hottest table in the product. A
   // flat "automations do not chain" rule needs no column, cannot be defeated
   // by a cycle of any length, and is trivial to relax later.
   //
   // THE OTHER ACTION IS COVERED BY ABSENCE, NOT BY THIS CHECK. `create_task`
   // writes `tasks`, and `tasks` has no entry in FLOW_EVENT_BY_CHANGE -- there
   // is no task event to trigger on, so a created task cannot start a run in
   // the first place. Adding 'tasks:INSERT' to that map WOULD create a cycle
   // this brake cannot see, because a task row carries no sender_kind. If that
   // event is ever wanted, `tasks.source_type = 'automation'` is the equivalent
   // marker and this condition must be widened to skip it at the same time.
   // Pinned by "a task an automation created cannot trigger an automation" in
   // tests/automations.test.cjs.
   if (table === 'messages' && String(row?.sender_kind || '') === AUTOMATION_SENDER_KIND) continue;
   if (table === 'tasks' && String(row?.source_type || '') === AUTOMATION_TASK_SOURCE_TYPE) continue;

   const location = await flowEventLocation(table, row);
   if (!location?.workspaceId) continue;

   const matches = await matchAutomations(location.workspaceId, flowEventType);
   if (matches.length > AUTOMATION_MAX_MATCHES_PER_EVENT) {
    onWarn(`event ${flowEventType} in workspace ${location.workspaceId} matched ${matches.length} automations; running the first ${AUTOMATION_MAX_MATCHES_PER_EVENT}`);
   }
   const capped = matches.slice(0, AUTOMATION_MAX_MATCHES_PER_EVENT);
   if (capped.length === 0) continue;

   const record = publicFlowEventRecord(table, row);
   const version = row.version || row.updated_at || row.created_at
    || crypto.createHash('sha256').update(JSON.stringify(record)).digest('hex').slice(0, 16);
   const eventId = `${flowEventType}:${row.id || row.user_id}:${version}`;
   const payload = {
    id: eventId,
    type: flowEventType,
    occurredAt: new Date().toISOString(),
    workspaceId: location.workspaceId,
    channelId: location.channelId || null,
    data: record,
   };

   for (const automation of capped) {
    const definition = parseDefinition(automation.definition);
    // Conditions are evaluated HERE, before the row is written, so an event
    // that does not match costs one evaluation and no queue row at all.
    if (!evaluateConditions(definition.when, payload)) continue;

    const recent = await recentRunCount(automation.id);
    if (recent >= AUTOMATION_MAX_RUNS_PER_MINUTE) {
     const strikes = (runawayStrikes.get(String(automation.id)) || 0) + 1;
     runawayStrikes.set(String(automation.id), strikes);
     if (strikes >= AUTOMATION_RUNAWAY_STRIKES) {
      await disableRunaway(automation, `More than ${AUTOMATION_MAX_RUNS_PER_MINUTE} runs a minute, ${strikes} times in a row.`);
     } else {
      onWarn(`automation ${automation.id} over its rate limit (strike ${strikes})`);
     }
     continue;
    }
    runawayStrikes.delete(String(automation.id));

    const inserted = await getDb().unsafe(
     `insert into automation_runs (automation_id, workspace_id, event_id, event_type, payload)
        values ($1, $2, $3, $4, $5::jsonb)
        on conflict (automation_id, event_id) do nothing
        returning *`,
     [String(automation.id), String(location.workspaceId), eventId, flowEventType, payload],
    );
    if (inserted[0]) queued.push(inserted[0]);
   }
  }
  return queued;
 }

 function parseDefinition(value) {
  if (!value) return { when: [], steps: [] };
  if (typeof value === 'string') {
   try { return JSON.parse(value) || { when: [], steps: [] }; } catch { return { when: [], steps: [] }; }
  }
  return value;
 }

 // ---------------------------------------------------------------------------
 // Execution
 // ---------------------------------------------------------------------------

 /**
  * Settle a claimed run.
  *
  * ALWAYS returns a result, even when the UPDATE matched nothing (the run or its
  * automation was hard-deleted mid-flight). The claim already happened, so this
  * tick DID do work; returning null here would abort the drain loop and leave
  * the rest of a backlog sitting for another 30 seconds. This is the
  * thread-harvest finishHarvest lesson, restated because it is easy to lose.
  */
 async function finishRun(runId, patch) {
  const rows = await getDb().unsafe(
   `update automation_runs
       set status = $2, steps = $3::jsonb, error = $4, updated_at = now()
     where id = $1
     returning *`,
   [String(runId), patch.status, patch.steps ?? [], patch.error ?? null],
  );
  if (rows.length) notifyDbSubscribers('automation_runs', 'UPDATE', rows);
  return rows[0] || { id: runId, status: patch.status, steps: patch.steps ?? [], error: patch.error ?? null };
 }

 /**
  * Claim one pending run with a compare-and-set plus a lease token.
  *
  * The `and status = 'pending'` after the subquery is the compare-and-set: two
  * processes selecting the same candidate row cannot both update it. A bare
  * SELECT-then-UPDATE would let both run the same automation.
  */
 async function claimAutomationRun() {
  const claimToken = crypto.randomUUID();
  const rows = await getDb().unsafe(
   `update automation_runs
       set status = 'inflight',
           claim_token = $1,
           attempt_count = attempt_count + 1,
           lease_expires_at = now() + ($2 || ' milliseconds')::interval,
           updated_at = now()
     where id = (
       select id from automation_runs
        where status = 'pending'
        order by created_at asc
        limit 1
        for update skip locked
     )
     and status = 'pending'
     returning *`,
   [claimToken, String(AUTOMATION_LEASE_MS)],
  );
  return rows[0] || null;
 }

 /** Insert the message an automation posts. No agent is woken; see the header. */
 async function runPostMessageStep(step, run, payload) {
  const channelId = String(step.channelId || '').trim();
  const sessions = await getDb().unsafe(
   'select id, workspace_id from chat_sessions where id = $1 limit 1',
   [channelId],
  );
  const session = sessions[0];
  // A channel that has gone, or one in another workspace, is a PERMANENT
  // failure: retrying it three times cannot make it succeed, and an automation
  // must never be able to write into a workspace it does not belong to.
  if (!session) return { action: step.action, ok: false, permanent: true, error: 'channel not found' };
  if (String(session.workspace_id) !== String(run.workspace_id)) {
   return { action: step.action, ok: false, permanent: true, error: 'channel is not in this workspace' };
  }

  const text = interpolate(String(step.text || ''), payload);
  const rows = await getDb().unsafe(
   `insert into messages (session_id, role, content, sender_kind, sender_id, sender_name)
      values ($1, 'assistant', $2, $3, $4, $5)
      returning *`,
   [channelId, text, AUTOMATION_SENDER_KIND, String(run.automation_id), 'Automation'],
  );
  notifyDbSubscribers('messages', 'INSERT', rows);
  await getDb().unsafe('update chat_sessions set updated_at = now() where id = $1', [channelId]).catch(() => {});
  return { action: step.action, ok: true, messageId: rows[0]?.id || null };
 }

 /**
  * Insert the task an automation creates. No agent is woken; see the header.
  *
  * THE INSERT IS DIRECT, AND THAT IS THE POINT. Task dispatch is wired into the
  * /backend/db/insert route (server/index.cjs), not into a database trigger, and
  * it fires only on a non-empty `assignee_id`. Writing the row here therefore
  * takes neither path: no route, and no assignee to take it with. `assignee_id`
  * is not even a column this function mentions, and the validator drops the
  * field from any stored definition, so an automation cannot name one.
  *
  * Provenance goes in source_type / source_id rather than created_by, matching
  * what post_message does with sender_kind / sender_id: the automation made
  * this, not the person who happened to author the rule months ago.
  */
 async function runCreateTaskStep(step, run, payload) {
  const title = interpolate(String(step.title || ''), payload).slice(0, MAX_TASK_TITLE_LENGTH).trim();
  // A title that interpolated down to nothing is a PERMANENT failure. `tasks.title`
  // is NOT NULL and a blank one is unusable in the list anyway, so retrying it
  // three times cannot make it succeed — and a nameless task appearing on
  // somebody's board is worse than a run that says why it stopped.
  if (!title) {
   return { action: step.action, ok: false, permanent: true, error: 'task title is empty after interpolation' };
  }
  const description = interpolate(String(step.description || ''), payload);

  const rows = await getDb().unsafe(
   `insert into tasks (workspace_id, created_by, title, description, status, priority, source_type, source_id)
      values ($1, null, $2, $3, 'todo', 'normal', $4, $5)
      returning *`,
   [String(run.workspace_id), title, description, AUTOMATION_TASK_SOURCE_TYPE, String(run.automation_id)],
  );
  notifyDbSubscribers('tasks', 'INSERT', rows);
  return { action: step.action, ok: true, taskId: rows[0]?.id || null };
 }

 /** Run one claimed automation. Steps are serial and there are at most five. */
 async function runOneAutomation() {
  const run = await claimAutomationRun();
  if (!run) return null;

  const automations = await getDb().unsafe(
   'select * from automations where id = $1 limit 1',
   [String(run.automation_id)],
  );
  const automation = automations[0];
  if (!automation) return finishRun(run.id, { status: 'error', error: 'automation not found' });
  // Disabled between enqueue and drain (possibly by the runaway guard). Skipped,
  // not run: `enabled` is the off switch and it has to work retroactively on
  // whatever is already queued, or disabling a runaway would not actually stop it.
  if (automation.enabled !== true) {
   return finishRun(run.id, { status: 'skipped', error: 'automation is disabled' });
  }

  const definition = parseDefinition(automation.definition);
  const payload = parseDefinition(run.payload);
  const results = [];
  let failed = null;

  // The runner's allowlist, kept as its own map rather than an if/else chain so
  // an action the VALIDATOR accepts but the runner cannot execute fails as
  // 'unsupported action' instead of falling through to whichever branch is
  // written last. Both sets must be widened together; neither is the other's
  // authority.
  const STEP_RUNNERS = {
   post_message: runPostMessageStep,
   create_task: runCreateTaskStep,
  };

  let lastAction = '';
  try {
   for (const step of Array.isArray(definition.steps) ? definition.steps : []) {
    lastAction = String(step?.action || '');
    const runStep = Object.prototype.hasOwnProperty.call(STEP_RUNNERS, lastAction)
     ? STEP_RUNNERS[lastAction]
     : null;
    if (!runStep) {
     results.push({ action: lastAction, ok: false, permanent: true, error: 'unsupported action' });
     failed = 'unsupported action';
     break;
    }
    const result = await runStep(step, run, payload);
    results.push(result);
    if (!result.ok) { failed = result.error; break; }
   }
  } catch (error) {
   failed = String(error?.message || error).slice(0, 500);
   results.push({ action: lastAction, ok: false, error: failed });
  }

  const permanent = results.some((result) => result.permanent === true);
  const exhausted = Number(run.attempt_count || 1) >= AUTOMATION_MAX_ATTEMPTS;
  // A permanent failure dead-letters immediately rather than burning every
  // attempt on something that cannot start working.
  const status = failed ? (permanent || exhausted ? 'dead' : 'error') : 'done';

  await getDb().unsafe(
   `update automations
       set run_count = run_count + 1,
           fail_count = fail_count + $2,
           last_run_at = now(),
           last_status = $3,
           updated_at = now()
     where id = $1`,
   [String(automation.id), failed ? 1 : 0, status],
  ).catch(() => {});

  return finishRun(run.id, { status, steps: results, error: failed });
 }

 /**
  * Drain a bounded number of runs per tick.
  *
  * BOUNDED, and that is the invariant rather than the number: this shares the
  * 30s reaper interval with the job reapers, schedules and thread harvests, so
  * an unbounded drain would let one backlog stall all of them.
  */
 async function runDueAutomations(limit = AUTOMATION_MAX_RUNS_PER_TICK) {
  if (!isEnabled()) return [];
  const done = [];
  for (let i = 0; i < limit; i += 1) {
   const result = await runOneAutomation().catch((error) => {
    onWarn(`tick failed: ${error.message || error}`);
    return null;
   });
   if (!result) break;
   done.push(result);
  }
  return done;
 }

 /**
  * Recover runs whose lease expired (the process died mid-run) and dead-letter
  * the ones that have used every attempt. Without this a crash wedges a run in
  * 'inflight' forever.
  */
 async function sweepAutomationRuns() {
  if (!isEnabled()) return { requeued: 0, dead: 0 };
  const dead = await getDb().unsafe(
   `update automation_runs
       set status = 'dead', error = coalesce(error, 'exceeded attempt limit'), updated_at = now()
     where status = 'inflight' and lease_expires_at < now() and attempt_count >= $1
     returning id`,
   [AUTOMATION_MAX_ATTEMPTS],
  );
  const requeued = await getDb().unsafe(
   `update automation_runs
       set status = 'pending', claim_token = null, lease_expires_at = null, updated_at = now()
     where status = 'inflight' and lease_expires_at < now()
     returning id`,
  );
  return { requeued: requeued.length, dead: dead.length };
 }

 // ---------------------------------------------------------------------------
 // CRUD
 // ---------------------------------------------------------------------------

 function publicAutomation(row) {
  if (!row) return null;
  const definition = parseDefinition(row.definition);
  return {
   id: row.id,
   workspace_id: row.workspace_id,
   name: row.name || '',
   description: row.description || '',
   enabled: row.enabled === true,
   trigger_event: row.trigger_event,
   definition,
   // Rendered server-side from the VALIDATED definition, for reading, diffing
   // and pasting. Display only; nothing parses it back.
   definition_yaml: renderDefinitionYaml(definition),
   created_by: row.created_by || null,
   run_count: Number(row.run_count || 0),
   fail_count: Number(row.fail_count || 0),
   last_run_at: row.last_run_at || null,
   last_status: row.last_status || '',
   disabled_reason: row.disabled_reason || '',
   created_at: row.created_at,
   updated_at: row.updated_at,
  };
 }

 async function listAutomations({ workspaceId, limit = 100 } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  const capped = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const rows = await getDb().unsafe(
   'select * from automations where workspace_id = $1 order by created_at desc limit $2',
   [id, capped],
  );
  return rows.map(publicAutomation);
 }

 async function listAutomationRuns({ workspaceId, automationId = '', limit = 50 } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const params = [id];
  let where = 'where workspace_id = $1';
  if (automationId) {
   params.push(String(automationId));
   where += ` and automation_id = $${params.length}`;
  }
  params.push(capped);
  return getDb().unsafe(
   `select id, automation_id, workspace_id, event_id, event_type, status,
           attempt_count, steps, error, created_at, updated_at
      from automation_runs ${where}
      order by created_at desc limit $${params.length}`,
   params,
  );
 }

 /** Validate, then build the row. The stored definition is the REBUILT one. */
 function definitionOrThrow(input) {
  const result = validateDefinition(input, { allowedEvents: flowEvents });
  if (!result.ok) throw badRequest(`Invalid automation: ${result.errors.join('; ')}`);
  return result.definition;
 }

 async function createAutomation({ userId, workspaceId, name, description, definition, enabled = false } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  await enforceWorkspaceRole(userId, id, 'manage');
  const validated = definitionOrThrow(definition);
  const rows = await getDb().unsafe(
   `insert into automations (workspace_id, name, description, enabled, trigger_event, definition, created_by)
      values ($1, $2, $3, $4, $5, $6::jsonb, $7)
      returning *`,
   [
    id,
    String(name || '').slice(0, 160),
    String(description || '').slice(0, 500),
    enabled === true,
    validated.trigger.event,
    validated,
    String(userId || ''),
   ],
  );
  notifyDbSubscribers('automations', 'INSERT', rows);
  await recordAudit({
   workspaceId: id,
   actor: { userId: String(userId || '') },
   action: 'automation.created',
   target: { type: 'automation', id: String(rows[0]?.id || ''), label: String(name || '') },
   after: enabled === true ? 'enabled' : 'disabled',
   detail: { trigger_event: validated.trigger.event, step_count: validated.steps.length, condition_count: validated.when.length },
  });
  return publicAutomation(rows[0]);
 }

 async function updateAutomation({ userId, workspaceId, automationId, patch = {} } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(automationId || '').trim();
  if (!id || !target) throw badRequest('workspace id and automation id are required');
  await enforceWorkspaceRole(userId, id, 'manage');

  const existingRows = await getDb().unsafe(
   'select * from automations where id = $1 and workspace_id = $2 limit 1',
   [target, id],
  );
  const existing = existingRows[0];
  if (!existing) throw notFound('Automation was not found');

  const validated = patch.definition === undefined
   ? parseDefinition(existing.definition)
   : definitionOrThrow(patch.definition);
  const name = patch.name === undefined ? existing.name : String(patch.name || '').slice(0, 160);
  const description = patch.description === undefined ? existing.description : String(patch.description || '').slice(0, 500);
  const enabled = patch.enabled === undefined ? existing.enabled === true : patch.enabled === true;
  // Re-enabling is what clears a runaway trip; that is the human acknowledgement
  // the guard was holding out for.
  const disabledReason = enabled ? '' : existing.disabled_reason || '';

  const rows = await getDb().unsafe(
   `update automations
       set name = $3, description = $4, enabled = $5, trigger_event = $6,
           definition = $7::jsonb, disabled_reason = $8, updated_at = now()
     where id = $1 and workspace_id = $2
     returning *`,
   [target, id, name, description, enabled, validated.trigger.event, validated, disabledReason],
  );
  if (!rows.length) throw notFound('Automation was not found');
  notifyDbSubscribers('automations', 'UPDATE', rows);

  // An enable/disable is its own audit action: "who turned this on" is a
  // different question from "who edited it", and the answer to the first is the
  // one that matters when something starts posting.
  const wasEnabled = existing.enabled === true;
  if (wasEnabled !== enabled) {
   await recordAudit({
    workspaceId: id,
    actor: { userId: String(userId || '') },
    action: enabled ? 'automation.enabled' : 'automation.disabled',
    target: { type: 'automation', id: target, label: name },
    before: wasEnabled ? 'enabled' : 'disabled',
    after: enabled ? 'enabled' : 'disabled',
    detail: { trigger_event: validated.trigger.event },
   });
  }
  if (patch.definition !== undefined || patch.name !== undefined || patch.description !== undefined) {
   await recordAudit({
    workspaceId: id,
    actor: { userId: String(userId || '') },
    action: 'automation.updated',
    target: { type: 'automation', id: target, label: name },
    before: String(existing.trigger_event || ''),
    after: validated.trigger.event,
    detail: { step_count: validated.steps.length, condition_count: validated.when.length },
   });
  }
  return publicAutomation(rows[0]);
 }

 async function deleteAutomation({ userId, workspaceId, automationId } = {}) {
  const id = String(workspaceId || '').trim();
  const target = String(automationId || '').trim();
  if (!id || !target) throw badRequest('workspace id and automation id are required');
  await enforceWorkspaceRole(userId, id, 'manage');
  const rows = await getDb().unsafe(
   'delete from automations where id = $1 and workspace_id = $2 returning *',
   [target, id],
  );
  if (!rows.length) throw notFound('Automation was not found');
  notifyDbSubscribers('automations', 'DELETE', rows);
  await recordAudit({
   workspaceId: id,
   actor: { userId: String(userId || '') },
   action: 'automation.deleted',
   target: { type: 'automation', id: target, label: String(rows[0].name || '') },
   before: rows[0].enabled === true ? 'enabled' : 'disabled',
   detail: { trigger_event: String(rows[0].trigger_event || '') },
  });
  return { id: target, deleted: true };
 }

 return {
  matchAutomations,
  enqueueAutomationRuns,
  claimAutomationRun,
  runOneAutomation,
  runDueAutomations,
  sweepAutomationRuns,
  listAutomations,
  listAutomationRuns,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  publicAutomation,
  __internals: { parseDefinition, disableRunaway, recentRunCount, runPostMessageStep, runCreateTaskStep },
 };
}

/**
 * Routes.
 *
 * MANAGE for every write. An automation is a STANDING grant to write into the
 * workspace whenever an event matches -- `run_agents` is "you may run something
 * now", `manage` is "you may configure the system to act without you". That is
 * the same gate agent_webhooks (the closest existing analogue, also a standing
 * grant) already uses on both its route and its table access.
 *
 * READ for the list and the run history, so anyone who can see the workspace can
 * see what is configured to act inside it. An automation that members cannot
 * discover is indistinguishable from the product behaving strangely.
 */
function mountAutomationRoutes(app, deps = {}) {
 const {
  requireAuth, jsonError, enforceWorkspaceRole,
  listAutomations, listAutomationRuns, createAutomation, updateAutomation, deleteAutomation,
  automationsEnabled = () => String(process.env.AGENSIS_AUTOMATIONS || '0') === '1',
 } = deps;

 // The feature flag gates the ROUTES as well as the worker. A flag that only
 // hid the UI would still let an automation be created and still run it.
 const flagged = (handler) => async (req, res) => {
  if (!automationsEnabled()) return jsonError(res, 404, Object.assign(new Error('Automations are not enabled'), { status: 404 }));
  return handler(req, res);
 };

 app.get('/backend/workspaces/:id/automations', requireAuth, flagged(async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   res.json({ data: await listAutomations({ workspaceId, limit: req.query?.limit }), error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 }));

 app.get('/backend/workspaces/:id/automation-runs', requireAuth, flagged(async (req, res) => {
  try {
   const workspaceId = String(req.params.id || '').trim();
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const data = await listAutomationRuns({
    workspaceId,
    automationId: req.query?.automationId,
    limit: req.query?.limit,
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 }));

 app.post('/backend/workspaces/:id/automations', requireAuth, flagged(async (req, res) => {
  try {
   const data = await createAutomation({
    userId: req.userId,
    workspaceId: String(req.params.id || '').trim(),
    name: req.body?.name,
    description: req.body?.description,
    definition: req.body?.definition,
    enabled: req.body?.enabled === true,
   });
   res.status(201).json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 }));

 app.patch('/backend/workspaces/:id/automations/:automationId', requireAuth, flagged(async (req, res) => {
  try {
   const data = await updateAutomation({
    userId: req.userId,
    workspaceId: String(req.params.id || '').trim(),
    automationId: String(req.params.automationId || '').trim(),
    patch: {
     ...(req.body?.name === undefined ? {} : { name: req.body.name }),
     ...(req.body?.description === undefined ? {} : { description: req.body.description }),
     ...(req.body?.definition === undefined ? {} : { definition: req.body.definition }),
     ...(req.body?.enabled === undefined ? {} : { enabled: req.body.enabled }),
    },
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 }));

 app.delete('/backend/workspaces/:id/automations/:automationId', requireAuth, flagged(async (req, res) => {
  try {
   const data = await deleteAutomation({
    userId: req.userId,
    workspaceId: String(req.params.id || '').trim(),
    automationId: String(req.params.automationId || '').trim(),
   });
   res.json({ data, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 }));
}

module.exports = {
 createAutomations,
 mountAutomationRoutes,
 AUTOMATION_MAX_RUNS_PER_TICK,
 AUTOMATION_MAX_MATCHES_PER_EVENT,
 AUTOMATION_MAX_RUNS_PER_MINUTE,
 AUTOMATION_RUNAWAY_STRIKES,
 AUTOMATION_MAX_ATTEMPTS,
 AUTOMATION_LEASE_MS,
 AUTOMATION_SENDER_KIND,
};
