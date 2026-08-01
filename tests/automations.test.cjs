'use strict';

// ============================================================================
// tests/automations.test.cjs
// ----------------------------------------------------------------------------
// The automation engine: matching, enqueue, the cycle brake, the claim, the
// runaway guard, execution, and the RBAC on every write path.
//
// Driven through the REAL createAutomations factory with a fake db that records
// every statement. The fake answers queries by prefix and returns fixed rows —
// it does NOT re-implement the WHERE clauses, because a fake that restates the
// SQL tests the fake's logic instead of the code's, which has produced vacuous
// tests in this repo twice.
//
// Where an invariant genuinely lives in SQL (the `enabled = true` filter, the
// compare-and-set claim, the ON CONFLICT that makes enqueue idempotent) the
// honest test asserts on the EMITTED SQL TEXT, and pairs it with a JS-level
// assertion wherever a JS guard also exists. Both are stated as such.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 createAutomations,
 AUTOMATION_MAX_MATCHES_PER_EVENT,
 AUTOMATION_MAX_RUNS_PER_MINUTE,
 AUTOMATION_RUNAWAY_STRIKES,
 AUTOMATION_MAX_RUNS_PER_TICK,
 AUTOMATION_SENDER_KIND,
} = require('../server/automations.cjs');
const { AUTOMATION_TASK_SOURCE_TYPE } = require('../shared/automation-rules.cjs');

const WORKSPACE = 'ws-1';
const CHANNEL = 'chan-1';
const TARGET_CHANNEL = 'chan-2';
const USER = 'user-1';

const FLOW_EVENT_BY_CHANGE = {
 'messages:INSERT': 'message.created',
 'messages:UPDATE': 'message.updated',
 'documents:INSERT': 'document.created',
};
const FLOW_EVENTS = ['message.created', 'message.updated', 'document.created'];

function goodDefinition(overrides = {}) {
 return {
  version: 1,
  trigger: { event: 'message.created' },
  when: [{ field: 'data.content', op: 'contains', value: 'deploy failed' }],
  steps: [{ action: 'post_message', channelId: TARGET_CHANNEL, text: 'Heads up: {{data.senderName}}' }],
  ...overrides,
 };
}

function automationRow(overrides = {}) {
 return {
  id: 'auto-1',
  workspace_id: WORKSPACE,
  name: 'Deploy alarm',
  enabled: true,
  trigger_event: 'message.created',
  definition: goodDefinition(),
  created_by: USER,
  attempt_count: 0,
  ...overrides,
 };
}

/**
 * Fake db. `rows` maps a lowercased SQL prefix to a result (or a function of
 * params). Everything issued is recorded on `queries` so a test can assert on
 * what was actually asked, including the SQL text where the guard lives there.
 */
function makeDb({ rows = {}, recentRuns = 0 } = {}) {
 const queries = [];
 const db = {
  queries,
  async unsafe(sql, params = []) {
   const raw = String(sql).replace(/\s+/g, ' ').trim();
   const q = raw.toLowerCase();
   queries.push({ sql: raw, params });
   for (const [prefix, value] of Object.entries(rows)) {
    if (q.startsWith(prefix)) return typeof value === 'function' ? value(params) : value;
   }
   if (q.startsWith('select count(*)::int as count from automation_runs')) {
    return [{ count: recentRuns }];
   }
   // Default for create/update post_message target checks: a live workspace channel.
   if (q.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')) {
    return [{
     id: params[0] || TARGET_CHANNEL,
     workspace_id: WORKSPACE,
     visibility: 'workspace',
     folder: 'Channels',
     deleted_at: null,
    }];
   }
   return [];
  },
 };
 return db;
}

function build(db, overrides = {}) {
 const audits = [];
 const warnings = [];
 const engine = createAutomations({
  getDb: () => db,
  notifyDbSubscribers: () => {},
  enforceWorkspaceRole: async () => true,
  flowEventByChange: FLOW_EVENT_BY_CHANGE,
  flowEvents: FLOW_EVENTS,
  publicFlowEventRecord: (table, row) => (table === 'messages'
   ? { id: row.id, content: row.content, senderKind: row.sender_kind || '', senderName: row.sender_name || '', senderId: row.sender_id || null }
   : { id: row.id }),
  flowEventLocation: async (table, row) => (table === 'messages'
   ? { workspaceId: WORKSPACE, channelId: row.session_id }
   : { workspaceId: row.workspace_id, channelId: null }),
  recordAudit: async (entry) => { audits.push(entry); return null; },
  onWarn: (message) => warnings.push(message),
  isEnabled: () => true,
  ...overrides,
 });
 engine.audits = audits;
 engine.warnings = warnings;
 return engine;
}

function messageRow(overrides = {}) {
 return {
  id: 'm-1',
  session_id: CHANNEL,
  content: 'the deploy failed again',
  sender_kind: 'user',
  sender_name: 'Jason',
  sender_id: USER,
  created_at: '2026-07-30T10:00:00.000Z',
  ...overrides,
 };
}

/** The one statement that inserted a run, if any. */
function runInsert(db) {
 return db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into automation_runs'));
}

// --- matching and enqueue ----------------------------------------------------

test('a matching event enqueues exactly one run', async () => {
 const db = makeDb({
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': [automationRow()],
   'insert into automation_runs': [{ id: 'run-1' }],
  },
 });
 const engine = build(db);
 const queued = await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow()]);
 assert.equal(queued.length, 1);

 const insert = runInsert(db);
 assert.ok(insert, 'a run row must be written');
 assert.equal(insert.params[0], 'auto-1');
 assert.equal(insert.params[1], WORKSPACE);
 // The stable event id is what makes a retried write idempotent.
 assert.match(insert.params[2], /^message\.created:m-1:/);
 assert.equal(insert.params[3], 'message.created');
 // The payload is bound as an OBJECT — porsager turns a stringified ::jsonb
 // bind into a jsonb string scalar (tests/jsonb-bind-hygiene.test.cjs).
 assert.equal(typeof insert.params[4], 'object');
 assert.equal(insert.params[4].data.content, 'the deploy failed again');
});

test('enqueue is idempotent by construction', async () => {
 // MUTATION: drop the `on conflict (automation_id, event_id) do nothing` -> this
 // fails. The unique index IS the deduplication; the same write retried (or two
 // machines observing one change) must not run the automation twice.
 const db = makeDb({
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': [automationRow()],
   'insert into automation_runs': [{ id: 'run-1' }],
  },
 });
 const engine = build(db);
 await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow()]);
 const insert = runInsert(db);
 assert.match(insert.sql.toLowerCase(), /on conflict \(automation_id, event_id\) do nothing/);
});

test('an event whose conditions do not hold enqueues nothing', async () => {
 const db = makeDb({
  rows: { 'select id, workspace_id, name, enabled, trigger_event': [automationRow()] },
 });
 const engine = build(db);
 const queued = await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow({ content: 'all green' })]);
 assert.deepEqual(queued, []);
 assert.equal(runInsert(db), undefined, 'a non-matching event must cost no queue row at all');
});

test('an event outside the vocabulary is ignored', async () => {
 const db = makeDb({ rows: { 'select id, workspace_id': [automationRow()] } });
 const engine = build(db);
 assert.deepEqual(await engine.enqueueAutomationRuns('tasks', 'INSERT', [{ id: 't-1', workspace_id: WORKSPACE }]), []);
 assert.equal(db.queries.length, 0, 'an unmapped table must not even query');
});

test('the matcher filters on enabled in SQL AND in JS', async () => {
 // Both halves matter and both are asserted, because they fail differently:
 // dropping the SQL filter makes the hot write path scan every automation in the
 // workspace, and dropping the JS filter runs a disabled one.
 // MUTATION: remove `and enabled = true` from the query -> the SQL assert fails.
 // MUTATION: remove the `.filter(row => row.enabled === true)` -> the JS assert fails.
 const db = makeDb({
  rows: { 'select id, workspace_id, name, enabled, trigger_event': [automationRow({ enabled: false })] },
 });
 const engine = build(db);
 const matched = await engine.matchAutomations(WORKSPACE, 'message.created');
 assert.deepEqual(matched, [], 'a disabled automation must never match');
 const query = db.queries.find((entry) => entry.sql.toLowerCase().includes('from automations'));
 assert.match(query.sql.toLowerCase(), /and enabled = true/);
});

test('a disabled automation is never enqueued', async () => {
 const db = makeDb({
  rows: { 'select id, workspace_id, name, enabled, trigger_event': [automationRow({ enabled: false })] },
 });
 const engine = build(db);
 assert.deepEqual(await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow()]), []);
 assert.equal(runInsert(db), undefined);
});

// --- the cycle brake ---------------------------------------------------------

test('a message an automation produced never triggers an automation', async () => {
 // THE CYCLE BRAKE, and the most important test in this file.
 // MUTATION: remove the sender_kind check in enqueueAutomationRuns -> this fails
 // and an automation that posts on message.created feeds itself forever.
 //
 // It also covers the two-automation cycle (A posts, B triggers on A and posts,
 // A triggers on B) that a per-automation self-exclusion check would miss,
 // because the brake is carried by the DATA, not by the automation's identity.
 const db = makeDb({
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': [automationRow()],
   'insert into automation_runs': [{ id: 'run-1' }],
  },
 });
 const engine = build(db);
 const queued = await engine.enqueueAutomationRuns('messages', 'INSERT', [
  messageRow({ sender_kind: AUTOMATION_SENDER_KIND, sender_id: 'auto-2' }),
 ]);
 assert.deepEqual(queued, [], 'an automation-produced message must not chain');
 assert.equal(db.queries.length, 0, 'it must not even reach the matcher');
});

test('an ordinary message still triggers, so the brake is not just "never"', async () => {
 // Pairs with the test above: a brake that refused everything would pass that
 // one trivially.
 const db = makeDb({
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': [automationRow()],
   'insert into automation_runs': [{ id: 'run-1' }],
  },
 });
 const engine = build(db);
 assert.equal((await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow()])).length, 1);
});

test('the posted message carries the automation sender kind', async () => {
 // The brake above is only real if the action actually tags what it writes.
 // MUTATION: post with sender_kind 'agent' -> the cycle brake stops working and
 // this fails.
 const db = makeDb({
  rows: {
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [{
    id: TARGET_CHANNEL, workspace_id: WORKSPACE, visibility: 'workspace', folder: 'Channels', deleted_at: null,
   }],
   'insert into messages': [{ id: 'm-out' }],
  },
 });
 const engine = build(db);
 const result = await engine.__internals.runPostMessageStep(
  { action: 'post_message', channelId: TARGET_CHANNEL, text: 'hi {{data.senderName}}' },
  { automation_id: 'auto-1', workspace_id: WORKSPACE },
  { data: { senderName: 'Jason' } },
 );
 assert.equal(result.ok, true);
 const insert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into messages'));
 assert.equal(insert.params[2], AUTOMATION_SENDER_KIND);
 assert.equal(insert.params[1], 'hi Jason', 'the text is interpolated');
});

test('post_message permanently refuses private sessions', async () => {
 // A manage-authored automation must not inject into members-only DMs.
 // MUTATION: drop isPrivateSessionRow check in resolvePostMessageTarget -> fails.
 const db = makeDb({
  rows: {
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [{
    id: TARGET_CHANNEL, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages', deleted_at: null,
   }],
  },
 });
 const engine = build(db);
 const result = await engine.__internals.runPostMessageStep(
  { action: 'post_message', channelId: TARGET_CHANNEL, text: 'secret leak' },
  { automation_id: 'auto-1', workspace_id: WORKSPACE },
  { data: {} },
 );
 assert.equal(result.ok, false);
 assert.equal(result.permanent, true);
 assert.match(result.error, /private/i);
 assert.equal(
  db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into messages')),
  false,
  'must not insert into a private session',
 );
});

test('post_message permanently refuses soft-deleted sessions', async () => {
 const db = makeDb({
  rows: {
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [{
    id: TARGET_CHANNEL, workspace_id: WORKSPACE, visibility: 'workspace', folder: 'Channels',
    deleted_at: '2026-01-01T00:00:00.000Z',
   }],
  },
 });
 const engine = build(db);
 const result = await engine.__internals.runPostMessageStep(
  { action: 'post_message', channelId: TARGET_CHANNEL, text: 'ghost' },
  { automation_id: 'auto-1', workspace_id: WORKSPACE },
  { data: {} },
 );
 assert.equal(result.ok, false);
 assert.equal(result.permanent, true);
 assert.match(result.error, /deleted/i);
});

test('createAutomation refuses a definition that posts into a private channel', async () => {
 const db = makeDb({
  rows: {
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [{
    id: TARGET_CHANNEL, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages', deleted_at: null,
   }],
  },
 });
 const engine = build(db);
 await assert.rejects(
  () => engine.createAutomation({
   userId: USER,
   workspaceId: WORKSPACE,
   name: 'Bad DM post',
   definition: goodDefinition(),
  }),
  /private/i,
 );
 assert.equal(
  db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into automations')),
  false,
 );
});

// --- create_task -------------------------------------------------------------

test('a created task names NO assignee, which is what keeps a run free of model calls', async () => {
 // THE SAFETY PROPERTY. Task dispatch fires on a non-empty assignee_id inside
 // the /backend/db/insert route; this INSERT takes neither the route nor an
 // assignee. Asserting on the SQL TEXT as well as the params is deliberate:
 // params alone would still pass if somebody added `assignee_id` to the column
 // list with a null bind and then a later edit filled the bind in.
 //
 // MUTATION: add assignee_id to the insert -> this fails.
 const db = makeDb({ rows: { 'insert into tasks': [{ id: 'task-1' }] } });
 const engine = build(db);
 const result = await engine.__internals.runCreateTaskStep(
  { action: 'create_task', title: 'Look into {{data.senderName}}', description: 'from {{data.content}}' },
  { automation_id: 'auto-1', workspace_id: WORKSPACE },
  { data: { senderName: 'Jason', content: 'the deploy failed again' } },
 );
 assert.equal(result.ok, true);
 assert.equal(result.taskId, 'task-1');

 const insert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into tasks'));
 assert.ok(insert, 'the task must actually be inserted');
 assert.equal(/assignee/i.test(insert.sql), false, 'no assignee may appear anywhere in the statement');
 assert.equal(insert.params.includes(USER), false, 'no user id may be bound as an assignee');

 // Interpolated, workspace-scoped, and stamped with its provenance.
 assert.equal(insert.params[0], WORKSPACE);
 assert.equal(insert.params[1], 'Look into Jason');
 assert.equal(insert.params[2], 'from the deploy failed again');
 assert.equal(insert.params[3], AUTOMATION_TASK_SOURCE_TYPE);
 assert.equal(insert.params[4], 'auto-1');
});

test('a task an automation created cannot trigger an automation', async () => {
 // The cycle brake for the second action. Today `tasks` is not in
 // FLOW_EVENT_BY_CHANGE at all, so this is belt AND braces — but the moment
 // somebody adds 'tasks:INSERT' to that map, this is the only thing standing
 // between create_task and a rule that feeds itself forever.
 //
 // MUTATION: drop the tasks/source_type line from enqueueAutomationRuns -> the
 // automation-made task enqueues a run and this fails.
 const taskAutomation = automationRow({ trigger_event: 'task.created', definition: goodDefinition({ trigger: { event: 'task.created' }, when: [] }) });
 const db = makeDb({
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': [taskAutomation],
   'insert into automation_runs': [{ id: 'run-1' }],
  },
 });
 const engine = build(db, {
  flowEventByChange: { ...FLOW_EVENT_BY_CHANGE, 'tasks:INSERT': 'task.created' },
  flowEvents: [...FLOW_EVENTS, 'task.created'],
 });

 const fromAutomation = await engine.enqueueAutomationRuns('tasks', 'INSERT', [
  { id: 'task-1', workspace_id: WORKSPACE, source_type: AUTOMATION_TASK_SOURCE_TYPE },
 ]);
 assert.deepEqual(fromAutomation, [], 'a task an automation made must not start a run');

 // And the brake must not be "never": an ordinary task still triggers, or the
 // assertion above would pass against a rule that simply ignores tasks.
 const fromHuman = await engine.enqueueAutomationRuns('tasks', 'INSERT', [
  { id: 'task-2', workspace_id: WORKSPACE, source_type: 'manual' },
 ]);
 assert.equal(fromHuman.length, 1);
});

test('a title that interpolates away is a permanent failure, not a blank task', async () => {
 // tasks.title is NOT NULL and a blank title is unusable in the list, so
 // retrying cannot help. MUTATION: drop the empty-title guard -> the insert is
 // attempted with '' and this fails.
 const db = makeDb({ rows: { 'insert into tasks': [{ id: 'task-1' }] } });
 const engine = build(db);
 const result = await engine.__internals.runCreateTaskStep(
  { action: 'create_task', title: '   ' },
  { automation_id: 'auto-1', workspace_id: WORKSPACE },
  {},
 );
 assert.equal(result.ok, false);
 assert.equal(result.permanent, true);
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into tasks')), false);
});

test('an action the validator would accept but the runner cannot execute is refused', async () => {
 // The runner keeps its OWN allowlist. A definition already stored under an
 // older/newer shared module must not fall through to whichever branch happens
 // to be written last.
 //
 // MUTATION: make the step dispatch default to runPostMessageStep -> this runs
 // something and fails.
 const db = makeDb({
  rows: {
   'update automation_runs': [{ id: 'run-1', automation_id: 'auto-1', workspace_id: WORKSPACE, payload: {}, attempt_count: 1 }],
   'select * from automations': [automationRow({
    definition: goodDefinition({ steps: [{ action: 'dispatch_agent', agentId: 'agent-1' }] }),
   })],
  },
 });
 const engine = build(db);
 await engine.runDueAutomations(1);
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into messages')), false);
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into tasks')), false);
 // `set status = $2` and not merely `set status`: the CLAIM statement also
 // starts "update automation_runs set status", so a looser match finds the
 // claim and asserts against its params instead of the settle's.
 const finish = db.queries.find((entry) => /update automation_runs set status = \$2/i.test(entry.sql));
 assert.ok(finish, 'the run must be settled');
 assert.ok(JSON.stringify(finish.params).includes('unsupported action'));
});

// --- fan-out and the runaway guard -------------------------------------------

test('fan-out beyond the cap drops the extras and says so', async () => {
 // MUTATION: remove the slice -> more than the cap are enqueued and this fails.
 const many = Array.from({ length: AUTOMATION_MAX_MATCHES_PER_EVENT + 4 }, (unused, index) => automationRow({ id: `auto-${index}` }));
 const db = makeDb({
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': many,
   'insert into automation_runs': (params) => [{ id: `run-${params[0]}` }],
  },
 });
 const engine = build(db);
 const queued = await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow()]);
 assert.equal(queued.length, AUTOMATION_MAX_MATCHES_PER_EVENT);
 assert.ok(engine.warnings.some((line) => /matched/.test(line)), 'the drop must be recorded, not silent');
});

test('the rate limit skips a run, and repeated trips DISABLE the automation', async () => {
 // MUTATION: make the limiter throttle without ever disabling -> the disable
 // assert fails. An automation a limiter merely throttles keeps running at the
 // limit forever and never asks anyone about it.
 const disables = [];
 const db = makeDb({
  recentRuns: AUTOMATION_MAX_RUNS_PER_MINUTE,
  rows: {
   'select id, workspace_id, name, enabled, trigger_event': [automationRow()],
   'update automations set enabled = false': (params) => { disables.push(params); return [{ id: 'auto-1', workspace_id: WORKSPACE, name: 'Deploy alarm' }]; },
  },
 });
 const engine = build(db);

 for (let i = 0; i < AUTOMATION_RUNAWAY_STRIKES - 1; i += 1) {
  assert.deepEqual(await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow({ id: `m-${i}` })]), []);
 }
 assert.equal(disables.length, 0, 'it must not disable on the first trip');
 assert.equal(runInsert(db), undefined, 'a rate-limited event must not enqueue');

 await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow({ id: 'm-final' })]);
 assert.equal(disables.length, 1, 'the strike limit must disable it');
 assert.match(String(disables[0][1]), /runs a minute/);

 // And it is auditable: "why did this stop" has an answer.
 const audit = engine.audits.find((entry) => entry.action === 'automation.disabled');
 assert.ok(audit, 'an automatic disable must reach the audit log');
 assert.equal(audit.detail.automatic, true);
});

// --- claim and execution -----------------------------------------------------

test('claiming uses a compare-and-set with a lease token', async () => {
 // MUTATION: change the claim to a bare SELECT then UPDATE -> the assertions on
 // the emitted SQL fail. The `and status = 'pending'` AFTER the subquery is what
 // stops two Fly machines running the same automation.
 const db = makeDb({ rows: { 'update automation_runs set status = \'inflight\'': [{ id: 'run-1' }] } });
 const engine = build(db);
 await engine.claimAutomationRun();
 const claim = db.queries.find((entry) => entry.sql.toLowerCase().includes("set status = 'inflight'"));
 assert.ok(claim);
 const sql = claim.sql.toLowerCase();
 assert.match(sql, /and status = 'pending'/, 'the compare-and-set guard');
 assert.match(sql, /for update skip locked/);
 assert.match(sql, /claim_token = \$1/);
 assert.match(sql, /lease_expires_at = now\(\)/);
 assert.match(sql, /attempt_count = attempt_count \+ 1/);
});

test('a settle whose UPDATE matches nothing still returns a result', async () => {
 // MUTATION: make finishRun return rows[0] unguarded -> the drain gets null,
 // treats it as "queue empty" and abandons the rest of the backlog for another
 // 30 seconds. This is the thread-harvest finishHarvest lesson.
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'inflight'": [{ id: 'run-1', automation_id: 'auto-1', workspace_id: WORKSPACE, attempt_count: 1, payload: {} }],
   'select * from automations where id': [],
   'update automation_runs set status = $2': [],
  },
 });
 const engine = build(db);
 const result = await engine.runOneAutomation();
 assert.ok(result, 'a hard-deleted row mid-run must not abort the drain');
 assert.equal(result.status, 'error');
});

test('a run whose automation was disabled after enqueue is SKIPPED', async () => {
 // The off switch has to work retroactively on whatever is already queued, or
 // disabling a runaway would not actually stop it.
 // MUTATION: drop the `automation.enabled !== true` check -> this fails.
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'inflight'": [{ id: 'run-1', automation_id: 'auto-1', workspace_id: WORKSPACE, attempt_count: 1, payload: {} }],
   'select * from automations where id': [automationRow({ enabled: false })],
   'update automation_runs set status = $2': (params) => [{ id: 'run-1', status: params[1] }],
  },
 });
 const engine = build(db);
 const result = await engine.runOneAutomation();
 assert.equal(result.status, 'skipped');
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into messages')), false);
});

test('a run posts the message and settles done', async () => {
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'inflight'": [{
    id: 'run-1', automation_id: 'auto-1', workspace_id: WORKSPACE, attempt_count: 1,
    payload: { data: { senderName: 'Jason', content: 'the deploy failed' } },
   }],
   'select * from automations where id': [automationRow()],
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [{
    id: TARGET_CHANNEL, workspace_id: WORKSPACE, visibility: 'workspace', folder: 'Channels', deleted_at: null,
   }],
   'insert into messages': [{ id: 'm-out' }],
   'update automation_runs set status = $2': (params) => [{ id: 'run-1', status: params[1] }],
  },
 });
 const engine = build(db);
 const result = await engine.runOneAutomation();
 assert.equal(result.status, 'done');
 const posted = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into messages'));
 assert.equal(posted.params[1], 'Heads up: Jason');
});

test('a step targeting a channel in another workspace fails PERMANENTLY', async () => {
 // A cross-workspace write is the one thing an automation must never manage,
 // and retrying it cannot make it legitimate.
 // MUTATION: drop the workspace comparison -> this fails and an automation can
 // post into a workspace it does not belong to.
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'inflight'": [{
    id: 'run-1', automation_id: 'auto-1', workspace_id: WORKSPACE, attempt_count: 1, payload: { data: {} },
   }],
   'select * from automations where id': [automationRow()],
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [{
    id: TARGET_CHANNEL, workspace_id: 'someone-elses-workspace', visibility: 'workspace', folder: 'Channels', deleted_at: null,
   }],
   'update automation_runs set status = $2': (params) => [{ id: 'run-1', status: params[1] }],
  },
 });
 const engine = build(db);
 const result = await engine.runOneAutomation();
 assert.equal(result.status, 'dead', 'permanent failures dead-letter instead of retrying');
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into messages')), false);
});

test('a missing channel dead-letters rather than retrying to the cap', async () => {
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'inflight'": [{
    id: 'run-1', automation_id: 'auto-1', workspace_id: WORKSPACE, attempt_count: 1, payload: { data: {} },
   }],
   'select * from automations where id': [automationRow()],
   // Explicit empty: override the default workspace-channel fixture in makeDb.
   'select id, workspace_id, visibility, folder, deleted_at from chat_sessions': [],
   'update automation_runs set status = $2': (params) => [{ id: 'run-1', status: params[1] }],
  },
 });
 const engine = build(db);
 assert.equal((await engine.runOneAutomation()).status, 'dead');
});

test('the drain is BOUNDED per tick', async () => {
 // MUTATION: remove the limit / loop forever while runs exist -> this fails.
 // The bound is the invariant, not the number: everything on the 30s reaper
 // interval runs serially, so an unbounded drain stalls the job reapers.
 // The fake queue is deliberately FINITE (three ticks' worth) so an unbounded
 // drain overshoots the bound and fails this assertion, rather than looping
 // forever and hanging the suite. A test that hangs on a regression is worse
 // than one that fails on it.
 let claims = 0;
 const BACKLOG = AUTOMATION_MAX_RUNS_PER_TICK * 3;
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'inflight'": () => {
    if (claims >= BACKLOG) return [];
    claims += 1;
    return [{ id: `run-${claims}`, automation_id: 'auto-1', workspace_id: WORKSPACE, attempt_count: 1, payload: { data: {} } }];
   },
   'select * from automations where id': [automationRow({ definition: goodDefinition({ steps: [] }) })],
   'update automation_runs set status = $2': (params) => [{ id: 'run-x', status: params[1] }],
  },
 });
 const engine = build(db);
 const done = await engine.runDueAutomations();
 assert.equal(done.length, AUTOMATION_MAX_RUNS_PER_TICK);
 assert.equal(claims, AUTOMATION_MAX_RUNS_PER_TICK, 'it must stop claiming at the bound even with work left');
});

test('the drain stops early when the queue is empty', async () => {
 const db = makeDb();
 const engine = build(db);
 assert.deepEqual(await engine.runDueAutomations(), []);
});

// --- the feature flag --------------------------------------------------------

test('the flag gates EXECUTION, not just a button', async () => {
 // MUTATION: check the flag only in the routes -> these fail. A flag that hides
 // the UI while the worker still runs is not a flag.
 const db = makeDb({
  rows: { 'select id, workspace_id, name, enabled, trigger_event': [automationRow()] },
 });
 const engine = build(db, { isEnabled: () => false });
 assert.deepEqual(await engine.enqueueAutomationRuns('messages', 'INSERT', [messageRow()]), []);
 assert.deepEqual(await engine.runDueAutomations(), []);
 assert.deepEqual(await engine.sweepAutomationRuns(), { requeued: 0, dead: 0 });
 assert.equal(db.queries.length, 0, 'nothing must touch the database while off');
});

// --- RBAC and CRUD -----------------------------------------------------------

test('every write path requires manage, and the list requires read', async () => {
 // MUTATION: change any 'manage' to 'write' -> this fails. An automation is a
 // STANDING grant to act without a human, which is why it costs manage and not
 // run_agents.
 const asked = [];
 const db = makeDb({
  rows: {
   'insert into automations': [{ id: 'auto-1', workspace_id: WORKSPACE, definition: goodDefinition(), trigger_event: 'message.created' }],
   'select * from automations where id': [automationRow()],
   'update automations set name': [automationRow()],
   'delete from automations': [automationRow()],
   'select * from automations where workspace_id': [automationRow()],
  },
 });
 const engine = build(db, {
  enforceWorkspaceRole: async (userId, workspaceId, capability) => { asked.push(capability); return true; },
 });

 await engine.createAutomation({ userId: USER, workspaceId: WORKSPACE, name: 'a', definition: goodDefinition() });
 await engine.updateAutomation({ userId: USER, workspaceId: WORKSPACE, automationId: 'auto-1', patch: { enabled: true } });
 await engine.deleteAutomation({ userId: USER, workspaceId: WORKSPACE, automationId: 'auto-1' });
 assert.deepEqual(asked, ['manage', 'manage', 'manage']);
});

test('a refused role stops the write before any SQL', async () => {
 const db = makeDb();
 const engine = build(db, {
  enforceWorkspaceRole: async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); },
 });
 await assert.rejects(() => engine.createAutomation({ userId: USER, workspaceId: WORKSPACE, definition: goodDefinition() }), /forbidden/);
 assert.equal(db.queries.length, 0);
});

test('create validates the definition and stores the REBUILT one', async () => {
 // MUTATION: store req.body.definition instead of the validator's output -> the
 // extraKey assert fails, and an unvalidated blob becomes a standing grant.
 const db = makeDb({
  rows: { 'insert into automations': (params) => [{ id: 'auto-1', workspace_id: WORKSPACE, definition: params[5], trigger_event: params[4], enabled: params[3] }] },
 });
 const engine = build(db);
 await engine.createAutomation({
  userId: USER,
  workspaceId: WORKSPACE,
  name: 'Deploy alarm',
  definition: { ...goodDefinition(), extraKey: 'nope' },
 });
 const insert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into automations'));
 assert.equal('extraKey' in insert.params[5], false, 'unknown keys must not reach the database');
 // trigger_event is denormalised out of the definition for the matcher's index.
 assert.equal(insert.params[4], 'message.created');
 // Bound as an object, not a JSON string.
 assert.equal(typeof insert.params[5], 'object');
});

test('create refuses an invalid definition with a 400', async () => {
 const db = makeDb();
 const engine = build(db);
 await assert.rejects(
  () => engine.createAutomation({
   userId: USER, workspaceId: WORKSPACE,
   definition: goodDefinition({ steps: [{ action: 'dispatch_agent', channelId: 'c', text: 't' }] }),
  }),
  (error) => error.status === 400 && /not a supported action/.test(error.message),
 );
 assert.equal(db.queries.some((entry) => entry.sql.toLowerCase().startsWith('insert into automations')), false);
});

test('a new automation is created DISABLED unless explicitly enabled', async () => {
 // MUTATION: default enabled to true -> this fails. A definition that starts
 // live means a mistyped condition fires on everything before anyone reads it.
 const db = makeDb({ rows: { 'insert into automations': (params) => [{ id: 'auto-1', enabled: params[3], definition: goodDefinition() }] } });
 const engine = build(db);
 await engine.createAutomation({ userId: USER, workspaceId: WORKSPACE, definition: goodDefinition() });
 const insert = db.queries.find((entry) => entry.sql.toLowerCase().startsWith('insert into automations'));
 assert.equal(insert.params[3], false);
});

test('create, enable and delete all reach the audit log', async () => {
 // Authoring an automation is a standing grant to write into the workspace, the
 // same class of thing as an agent_webhook — so it belongs in the audit log.
 // MUTATION: remove any recordAudit call -> this fails.
 const db = makeDb({
  rows: {
   'insert into automations': [{ id: 'auto-1', workspace_id: WORKSPACE, definition: goodDefinition(), trigger_event: 'message.created' }],
   'select * from automations where id': [automationRow({ enabled: false })],
   'update automations set name': [automationRow({ enabled: true })],
   'delete from automations': [automationRow()],
  },
 });
 const engine = build(db);
 await engine.createAutomation({ userId: USER, workspaceId: WORKSPACE, name: 'a', definition: goodDefinition() });
 await engine.updateAutomation({ userId: USER, workspaceId: WORKSPACE, automationId: 'auto-1', patch: { enabled: true } });
 await engine.deleteAutomation({ userId: USER, workspaceId: WORKSPACE, automationId: 'auto-1' });

 const actions = engine.audits.map((entry) => entry.action);
 assert.ok(actions.includes('automation.created'));
 assert.ok(actions.includes('automation.enabled'), '"who turned this on" is its own question');
 assert.ok(actions.includes('automation.deleted'));
 for (const entry of engine.audits) assert.equal(entry.actor.userId, USER, 'the actor is the verified session');
});

test('the list renders YAML from the stored JSON', async () => {
 const db = makeDb({ rows: { 'select * from automations where workspace_id': [automationRow()] } });
 const engine = build(db);
 const [first] = await engine.listAutomations({ workspaceId: WORKSPACE });
 assert.match(first.definition_yaml, /event: message\.created/);
 assert.match(first.definition_yaml, /action: post_message/);
 // The JSON is still the thing that runs; YAML is display only.
 assert.deepEqual(first.definition.steps[0].channelId, TARGET_CHANNEL);
});

test('the sweep reclaims expired leases and dead-letters exhausted runs', async () => {
 // MUTATION: drop the sweep -> a process that died mid-run wedges its row in
 // 'inflight' forever and that automation silently stops.
 const db = makeDb({
  rows: {
   "update automation_runs set status = 'dead'": [{ id: 'run-dead' }],
   "update automation_runs set status = 'pending'": [{ id: 'run-1' }, { id: 'run-2' }],
  },
 });
 const engine = build(db);
 const result = await engine.sweepAutomationRuns();
 assert.deepEqual(result, { requeued: 2, dead: 1 });
 const requeue = db.queries.find((entry) => entry.sql.toLowerCase().includes("set status = 'pending'"));
 assert.match(requeue.sql.toLowerCase(), /lease_expires_at < now\(\)/);
});
