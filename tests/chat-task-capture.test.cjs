// ============================================================================
// tests/chat-task-capture.test.cjs
// ----------------------------------------------------------------------------
// "If someone posts messages to channels or DMs that agents act on, and these
// are long running tasks so not conversational, we should automatically create
// tasks for them."
//
// The dispatch direction (assign a task -> agent gets a DM) already existed.
// This is the reverse: ask in chat -> a task appears, in progress, assigned to
// the agent that is answering, linked back to the conversation.
//
// What is under test:
//   1. a job still running past the threshold becomes a task, with the exact
//      row shape the UI needs (in_progress, assignee, source_type 'chat',
//      source_id = the session, origin_job_id = the job);
//   2. the title is the request, not the addressing, and is capped;
//   3. the LOOP GUARD — work that came FROM a task is never captured as a
//      second task. Without this, capture -> assignment -> dispatch -> capture;
//   4. machine-authored seeds (schedules, automations, integrations, other
//      agents) are never captured, but a human on a bridge is;
//   5. a spoken huddle turn is conversation however long it runs;
//   6. settle closes ONLY a captured task, ONLY from in_progress, ONLY on
//      'done' — an errored turn deliberately leaves its task open;
//   7. the column exists in all three places and is server-owned;
//   8. the wiring is real: the sweep is on the reaper tick and the terminal job
//      path calls settle.
//
// The db here is a dumb recorder. It answers with rows and records writes; it
// enforces none of the rules above, so every guard is being exercised in
// chat-task-capture.cjs rather than in the mock.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  createChatTaskCapture,
  chatTaskTitle,
  stripLeadingMentions,
} = require('../server/chat-task-capture.cjs');

const WS = 'ws-1';
const JOB_ID = 'job-1';
const SESSION_ID = 'sess-1';
const AGENT_ID = 'agent-1';
const HUMAN_ID = 'user-1';

// THE FIXTURES ARE THE PRODUCTION SHAPE, MEASURED, NOT AN IDEALISED ONE.
//
// The first version of this file set `created_by: HUMAN_ID` on the job, which
// looked reasonable and was wrong: on the daemon lane agent_jobs.created_by is
// ALWAYS null (runAgentTurn's createdBy defaults to null and the chat dispatch
// path never passes it — 12 of 12 most recent live jobs, zero with a value).
// The scan required the column, so it matched nothing in production while every
// test here passed. The default below is null on purpose so no test can drift
// back into asserting against data that does not occur.
function jobRow(over = {}) {
  return {
    id: JOB_ID,
    workspace_id: WS,
    agent_id: AGENT_ID,
    session_id: SESSION_ID,
    created_by: null,
    metadata: { lastSeenMessageId: 'msg-1', mode: 'daemon' },
    session_title: 'testtest',
    session_folder: '',
    agent_name: 'Claude',
    ...over,
  };
}

// Likewise measured: a human message from the browser carries sender_kind
// 'user' (not '') and sender_id = an app_users id, which loadSeedMessage
// resolves to author_id via the join.
function seedRow(over = {}) {
  return {
    id: 'msg-1',
    content: '@claude please migrate the billing tables and backfill the old rows',
    sender_kind: 'user',
    author_id: HUMAN_ID,
    deleted_at: null,
    thread_task_id: null,
    ...over,
  };
}

/**
 * Routes on the shape of the SQL, returns what the test set up, and records
 * every write. It never inspects the guard columns, so a guard that stopped
 * working would show up here as an extra insert.
 */
function makeDb({ jobs = [], seed = seedRow(), insertReturns = undefined, updateReturns = [] } = {}) {
  const calls = { selects: 0, inserts: [], updates: [] };
  const db = {
    unsafe: async (sql, params) => {
      const text = String(sql);
      if (text.includes('from agent_jobs')) { calls.selects += 1; return jobs; }
      if (text.includes('from messages')) return seed ? [seed] : [];
      if (text.startsWith('insert into tasks') || text.includes('insert into tasks')) {
        calls.inserts.push(params);
        if (insertReturns !== undefined) return insertReturns;
        return [{ id: 'task-new', workspace_id: WS, origin_job_id: params[6] }];
      }
      if (text.includes('update tasks')) { calls.updates.push({ sql: text, params }); return updateReturns; }
      throw new Error(`unexpected sql: ${text.slice(0, 80)}`);
    },
  };
  return { db, calls };
}

function makeCapture(dbSetup = {}) {
  const { db, calls } = makeDb(dbSetup);
  const published = [];
  const capture = createChatTaskCapture({
    getDb: () => db,
    notifyDbSubscribers: (table, event, rows) => published.push({ table, event, rows }),
  });
  return { capture, calls, published };
}

// --- 1. the row a capture writes -------------------------------------------

test('a job still running past the threshold becomes an in-progress task', async () => {
  const { capture, calls, published } = makeCapture({ jobs: [jobRow()] });
  const created = await capture.captureLongRunningChatTasks();

  assert.equal(created.length, 1);
  assert.equal(calls.inserts.length, 1);
  const [workspaceId, createdBy, assigneeId, title, description, sourceId, originJobId] = calls.inserts[0];
  assert.equal(workspaceId, WS);
  // Attributed to the human who asked — resolved from the SEED MESSAGE, since
  // the job row's own created_by is null on the daemon lane (see jobRow).
  assert.equal(createdBy, HUMAN_ID);
  assert.equal(assigneeId, AGENT_ID);
  // The back-link that makes the existing "Open chat" button work on this row.
  assert.equal(sourceId, SESSION_ID);
  assert.equal(originJobId, JOB_ID);
  assert.match(title, /migrate the billing tables/);
  assert.match(description, /migrate the billing tables/);
  // Realtime fanout, so the list updates without a reload.
  assert.deepEqual(published.map(p => [p.table, p.event]), [['tasks', 'INSERT']]);
});

test("the insert really says in_progress and 'chat', not todo", async () => {
  // Asserted against the SQL text: these two are literals in the statement, so
  // a change to either would otherwise pass every row-shape assertion above.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-task-capture.cjs'), 'utf8');
  const insert = source.slice(source.indexOf('insert into tasks'), source.indexOf('returning *'));
  assert.match(insert, /'in_progress'/);
  assert.match(insert, /'chat'/);
  assert.match(insert, /origin_job_id/);
  // Without ON CONFLICT the 30s sweep would insert a duplicate every tick for
  // the whole life of a long job.
  assert.match(insert, /on conflict \(origin_job_id\)[\s\S]*do nothing/);
});

test('a duplicate insert (another machine won the race) yields no task and no fanout', async () => {
  const { capture, calls, published } = makeCapture({ jobs: [jobRow()], insertReturns: [] });
  const created = await capture.captureLongRunningChatTasks();
  assert.equal(created.length, 0);
  assert.equal(calls.inserts.length, 1);
  assert.equal(published.length, 0);
});

// --- 1b. attribution, the bug that shipped ----------------------------------

test('a job with created_by NULL is still captured — the real daemon shape', async () => {
  // This is the exact row production produces, and the version that shipped
  // matched none of them. Asserted explicitly rather than relying on the
  // fixture default, so making jobRow "nicer" later cannot hide it again.
  const { capture, calls } = makeCapture({ jobs: [jobRow({ created_by: null })] });
  const created = await capture.captureLongRunningChatTasks();
  assert.equal(created.length, 1, 'a null created_by job was skipped');
  assert.equal(calls.inserts[0][1], HUMAN_ID, 'created_by did not come from the seed message');
});

test('the seed author wins over the job row, and the job row is the fallback', async () => {
  // Preferring job.created_by would put null in every captured row.
  const a = makeCapture({ jobs: [jobRow({ created_by: 'stale-user' })] });
  await a.capture.captureLongRunningChatTasks();
  assert.equal(a.calls.inserts[0][1], HUMAN_ID);

  // A sender we cannot resolve to an app_users row (a bridge's Telegram id)
  // falls back rather than dropping the capture.
  const b = makeCapture({
    jobs: [jobRow({ created_by: 'job-user' })],
    seed: seedRow({ author_id: null }),
  });
  await b.capture.captureLongRunningChatTasks();
  assert.equal(b.calls.inserts[0][1], 'job-user');
});

test('an unresolvable author does not block the capture', async () => {
  const { capture, calls } = makeCapture({
    jobs: [jobRow({ created_by: null })],
    seed: seedRow({ author_id: null, sender_kind: 'bridge' }),
  });
  const created = await capture.captureLongRunningChatTasks();
  assert.equal(created.length, 1);
  assert.equal(calls.inserts[0][1], null);
});

test('the seed lookup resolves the author through app_users, uuid-safely', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-task-capture.cjs'), 'utf8');
  const select = source.slice(source.indexOf('select m.id, m.content'), source.indexOf('limit 1'));
  assert.match(select, /author\.id as author_id/);
  // messages.sender_id is TEXT and a bridge fills it with a Telegram id;
  // tasks.created_by is uuid. Without the shape guard this cast throws 22P02
  // and the whole sweep logs a failure for every bridge message.
  assert.match(select, /m\.sender_id ~ '\^\[0-9a-fA-F-\]\{36\}\$'/);
  assert.match(select, /author\.id = m\.sender_id::uuid/);
});

// --- 2. the title ----------------------------------------------------------

test('the title is the request, with the addressing stripped', () => {
  assert.equal(chatTaskTitle('@claude fix the deploy'), 'fix the deploy');
  assert.equal(chatTaskTitle('@claude, @hermes: fix the deploy'), 'fix the deploy');
  assert.equal(stripLeadingMentions('@claude hi'), 'hi');
  // A mention in the MIDDLE is part of the sentence, not addressing.
  assert.equal(chatTaskTitle('ask @hermes about the schema'), 'ask @hermes about the schema');
});

test('the title is one capped line, and the body is not lost with it', async () => {
  const long = `${'x'.repeat(300)}\nsecond line`;
  const title = chatTaskTitle(long);
  assert.ok(title.length <= 90, `title was ${title.length}`);
  assert.ok(title.endsWith('…'));

  const { capture, calls } = makeCapture({ jobs: [jobRow()], seed: seedRow({ content: long }) });
  await capture.captureLongRunningChatTasks();
  // The full text survives in the description even though the title is cut.
  assert.ok(calls.inserts[0][4].includes('x'.repeat(300)));
});

test('a message with no usable text is not worth a task', async () => {
  for (const content of ['', '   ', '@claude']) {
    const { capture, calls } = makeCapture({ jobs: [jobRow()], seed: seedRow({ content }) });
    await capture.captureLongRunningChatTasks();
    assert.equal(calls.inserts.length, 0, `captured on ${JSON.stringify(content)}`);
  }
});

// --- 3. the loop guard -----------------------------------------------------

test('work that came FROM a task is never captured as a second task', async () => {
  // The dispatch direction's fingerprint: postTaskSubthreadMention seeds a
  // thread whose root carries source_task_id. Capturing it would mint a task
  // assigned to the same agent, which would dispatch, which would run long,
  // which would be captured again.
  const { capture, calls } = makeCapture({
    jobs: [jobRow()],
    seed: seedRow({ thread_task_id: 'task-existing' }),
  });
  const created = await capture.captureLongRunningChatTasks();
  assert.equal(created.length, 0);
  assert.equal(calls.inserts.length, 0);
});

test('the seed lookup reads source_task_id from the message AND its thread root', () => {
  // The guard above is only as good as the column it reads. A reply inside a
  // task subthread carries no source_task_id of its own — only the ROOT does.
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-task-capture.cjs'), 'utf8');
  const select = source.slice(source.indexOf('select m.id, m.content'), source.indexOf('limit 1'));
  assert.match(select, /coalesce\(m\.source_task_id, root\.source_task_id, parent\.source_task_id\)/);
});

// --- 4. who counts as "someone posting a message" ---------------------------

test('machine-authored seeds never mint a task', async () => {
  for (const sender_kind of ['agent', 'system', 'automation', 'integration']) {
    const { capture, calls } = makeCapture({ jobs: [jobRow()], seed: seedRow({ sender_kind }) });
    await capture.captureLongRunningChatTasks();
    assert.equal(calls.inserts.length, 0, `captured a ${sender_kind} message`);
  }
});

test('a human typing from a bridge still counts as someone posting', async () => {
  const { capture, calls } = makeCapture({ jobs: [jobRow()], seed: seedRow({ sender_kind: 'bridge' }) });
  await capture.captureLongRunningChatTasks();
  assert.equal(calls.inserts.length, 1);
});

test('a deleted seed message is not captured', async () => {
  const { capture, calls } = makeCapture({
    jobs: [jobRow()],
    seed: seedRow({ deleted_at: '2026-08-22T00:00:00Z' }),
  });
  await capture.captureLongRunningChatTasks();
  assert.equal(calls.inserts.length, 0);
});

test('a job with no seed message is skipped rather than titled generically', async () => {
  const { capture, calls } = makeCapture({
    jobs: [jobRow({ metadata: { mode: 'daemon' } })],
    seed: null,
  });
  await capture.captureLongRunningChatTasks();
  assert.equal(calls.inserts.length, 0);
});

// --- 5. huddles ------------------------------------------------------------

test('a spoken huddle turn is conversation however long it runs', async () => {
  const { capture, calls } = makeCapture({
    jobs: [jobRow({ metadata: { lastSeenMessageId: 'msg-1', voiceHuddle: true } })],
  });
  await capture.captureLongRunningChatTasks();
  assert.equal(calls.inserts.length, 0);
});

test('the candidate scan excludes farm jobs but does NOT require job.created_by', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'server', 'chat-task-capture.cjs'), 'utf8');
  const select = source.slice(source.indexOf('select j.id'), source.indexOf('order by j.started_at'));
  assert.match(select, /coalesce\(j\.metadata->>'mode', ''\) <> 'farm'/);
  assert.match(select, /j\.status = 'running'/);
  // The regression this whole file exists to prevent a second time. Requiring
  // agent_jobs.created_by matched 0 of 12 live jobs; the human comes from the
  // seed message instead.
  assert.doesNotMatch(select, /j\.created_by is not null/);
  // The threshold is what makes this "not conversational" — measured from
  // started_at, so a job that merely ticks cannot age into a task.
  assert.match(select, /j\.started_at < now\(\) - make_interval\(secs => \$1::int\)/);
  // Belt and braces against the sweep re-inserting for a job already captured.
  assert.match(select, /not exists \(select 1 from tasks t where t\.origin_job_id = j\.id\)/);
});

test('one bad job does not abort the rest of the batch', async () => {
  const good = jobRow({ id: 'job-2' });
  let first = true;
  const db = {
    unsafe: async (sql, params) => {
      const text = String(sql);
      if (text.includes('from agent_jobs')) return [jobRow(), good];
      if (text.includes('from messages')) return [seedRow()];
      if (text.includes('insert into tasks')) {
        if (first) { first = false; throw new Error('column "origin_job_id" does not exist'); }
        return [{ id: 'task-2', origin_job_id: params[6] }];
      }
      throw new Error(`unexpected sql: ${text.slice(0, 60)}`);
    },
  };
  const capture = createChatTaskCapture({ getDb: () => db, notifyDbSubscribers: () => {} });
  const created = await capture.captureLongRunningChatTasks();
  assert.equal(created.length, 1);
  assert.equal(created[0].origin_job_id, 'job-2');
});

test('a failed candidate scan is survivable, not a crashed sweep', async () => {
  const db = { unsafe: async () => { throw new Error('relation "tasks" does not exist'); } };
  const capture = createChatTaskCapture({ getDb: () => db, notifyDbSubscribers: () => {} });
  assert.deepEqual(await capture.captureLongRunningChatTasks(), []);
});

// --- 6. settling -----------------------------------------------------------

test('a finished turn closes the task it was captured as', async () => {
  const { capture, calls, published } = makeCapture({
    updateReturns: [{ id: 'task-new', status: 'done' }],
  });
  const settled = await capture.settleCapturedChatTask(JOB_ID, 'done');
  assert.ok(settled);
  assert.equal(calls.updates.length, 1);
  const { sql, params } = calls.updates[0];
  assert.equal(params[0], JOB_ID);
  // Keyed on origin_job_id ALONE — never on session or assignee, which would
  // let one agent's turn close an unrelated task.
  assert.match(sql, /where origin_job_id = \$1/);
  // Only from in_progress: a human who already moved it keeps their judgement.
  assert.match(sql, /and status = 'in_progress'/);
  assert.match(sql, /completed_at = now\(\)/);
  assert.deepEqual(published.map(p => [p.table, p.event]), [['tasks', 'UPDATE']]);
});

test('an errored or cancelled turn leaves its task open on purpose', async () => {
  for (const status of ['error', 'cancelled', 'running', '']) {
    const { capture, calls } = makeCapture();
    const settled = await capture.settleCapturedChatTask(JOB_ID, status);
    assert.equal(settled, null, `settled on ${status}`);
    assert.equal(calls.updates.length, 0, `wrote on ${status}`);
  }
});

test('settling a job that was never captured is a no-op, not an error', async () => {
  const { capture, published } = makeCapture({ updateReturns: [] });
  assert.equal(await capture.settleCapturedChatTask('job-never-captured', 'done'), null);
  assert.equal(published.length, 0);
});

test('a failed settle is swallowed rather than failing the job transition', async () => {
  const db = { unsafe: async () => { throw new Error('deadlock detected'); } };
  const capture = createChatTaskCapture({ getDb: () => db, notifyDbSubscribers: () => {} });
  assert.equal(await capture.settleCapturedChatTask(JOB_ID, 'done'), null);
});

// --- 7. the column is in all three places, and is server-owned --------------

test('origin_job_id exists in the schema, the runtime bootstrap, and the client denylist', () => {
  const root = path.join(__dirname, '..');
  const schema = fs.readFileSync(path.join(root, 'database', 'neon-schema.sql'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'server', 'index.cjs'), 'utf8');
  const core = fs.readFileSync(path.join(root, 'shared', 'backend-core.cjs'), 'utf8');

  for (const [name, text] of [['neon-schema.sql', schema], ['server/index.cjs', index]]) {
    assert.match(text, /ALTER TABLE tasks ADD COLUMN IF NOT EXISTS origin_job_id uuid REFERENCES agent_jobs\(id\)/, name);
    // The unique index IS the idempotency guarantee — see the module header.
    assert.match(text, /CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_origin_job/, name);
  }

  // Declared after agent_jobs in both, or the FK cannot resolve on a fresh push.
  assert.ok(
    schema.indexOf('origin_job_id uuid REFERENCES agent_jobs') > schema.indexOf('CREATE TABLE IF NOT EXISTS agent_jobs'),
    'tasks.origin_job_id is declared before agent_jobs exists',
  );

  // A browser that could set it could steer auto-completion onto another task.
  // Anchored to PRIVILEGED_DB_COLUMNS_BY_TABLE specifically: `tasks: new Set([`
  // also appears in JSON_COLUMNS_BY_TABLE, and matching that one instead would
  // make this assertion pass while the column stayed forgeable.
  // Anchored on the DECLARATION, not the name: the name first appears in a
  // comment ~270 lines earlier, and slicing from there lands inside
  // JSON_COLUMNS_BY_TABLE — which is how this assertion passed against the
  // wrong set on the first run.
  const owned = core.indexOf('const PRIVILEGED_DB_COLUMNS_BY_TABLE = {');
  assert.ok(owned > 0, 'PRIVILEGED_DB_COLUMNS_BY_TABLE declaration not found');
  const tasksOwned = core.slice(core.indexOf('tasks: new Set([', owned), core.indexOf('tasks: new Set([', owned) + 700);
  assert.match(tasksOwned, /'origin_job_id'/);
});

// --- 8. the wiring is real -------------------------------------------------

test('the sweep runs on the reaper tick and the terminal job path settles', () => {
  const root = path.join(__dirname, '..');
  const index = fs.readFileSync(path.join(root, 'server', 'index.cjs'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'server', 'agent-jobs.cjs'), 'utf8');

  assert.match(index, /require\('\.\/chat-task-capture\.cjs'\)/);
  assert.match(index, /guardedSweep\('captureLongRunningChatTasks', chatTaskCapture\.captureLongRunningChatTasks\)/);
  assert.match(index, /settleCapturedChatTask: \(\.\.\.a\) => chatTaskCapture\.settleCapturedChatTask\(\.\.\.a\)/);

  // Inside finalizeAgentJobResult, and on the afterDurableWrite queue so it
  // cannot commit ahead of the terminal row the daemon path holds open.
  const finalize = jobs.slice(jobs.indexOf('async function finalizeAgentJobResult'), jobs.indexOf('async function finalizeAgentJobResult') + 4000);
  assert.match(finalize, /afterDurableWrite\(\(\) => \{ void settleCapturedChatTask\(job\.id, status\); \}\)/);
});

test('server/index.cjs still loads with the new module wired in', () => {
  // The construction order matters: chatTaskCapture is built BEFORE agentJobs
  // because agentJobs takes settleCapturedChatTask as a dep. Getting that
  // backwards is a TDZ throw at require time, which this catches.
  assert.doesNotThrow(() => require('../server/index.cjs'));
});
