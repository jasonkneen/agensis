'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentJobs } = require('../server/agent-jobs.cjs');

const WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const AGENT_ID = '00000000-0000-4000-8000-000000000002';
const SESSION_ID = '00000000-0000-4000-8000-000000000003';
const JOB_ID = '00000000-0000-4000-8000-000000000004';

function normalizeSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

function parseJsonObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function makeBadRequest(message) {
  return Object.assign(new Error(message), { status: 400 });
}

/**
 * Stateful transaction double for the MCP finalization boundary.
 *
 * begin() serializes transactions the way the SELECT ... FOR UPDATE on the job
 * row does in PostgreSQL. Mutations happen against a private draft and are only
 * published on commit, so a transcript exception also rolls the terminal job CAS
 * back to running. That lets these tests exercise retries and competing submitters
 * without reducing the guarantee to a source-regex assertion.
 */
function makeHarness({ status = 'running', messages = [], failMessageInserts = 0 } = {}) {
  const durable = {
    job: {
      id: JOB_ID,
      workspace_id: WORKSPACE_ID,
      agent_id: AGENT_ID,
      session_id: SESSION_ID,
      status,
      response: '',
      error: '',
      metadata: { mode: 'mcp', threadParentId: null },
      agent_name: 'Q',
      agent_handle: 'q',
    },
    messages: messages.map((row) => ({ ...row })),
  };
  const calls = [];
  let insertSequence = durable.messages.length;
  let remainingInsertFailures = failMessageInserts;
  let transactionTail = Promise.resolve();

  async function unsafe(state, sql, params = [], transactional = false) {
    const n = normalizeSql(sql);
    calls.push({ n, params, transactional });

    if (n.startsWith('select j.*, a.name as agent_name') && n.includes('join chat_sessions s')) {
      assert.match(n, /j\.status = 'running'/, 'the authority lookup must exclude terminal rows');
      assert.match(n, /for update of j, s, a/, 'the job/session/agent scope must be locked together');
      return state.job.status === 'running' ? [{ ...state.job }] : [];
    }

    if (n.startsWith('update agent_jobs set status = $2')) {
      assert.match(n, /where id = \$1 and status = 'running'/,
        'the terminal CAS must independently require a running job');
      if (state.job.status !== 'running') return [];
      state.job = {
        ...state.job,
        status: params[1],
        response: params[2],
        error: params[3],
        metadata: params[4],
      };
      return [{ ...state.job }];
    }

    if (n.startsWith('insert into messages')) {
      if (remainingInsertFailures > 0) {
        remainingInsertFailures -= 1;
        throw new Error('transient transcript insert failure');
      }
      const row = {
        id: `00000000-0000-4000-9000-${String(++insertSequence).padStart(12, '0')}`,
        session_id: params[0],
        role: 'assistant',
        content: params[1],
        thread_parent_id: params[2],
        sender_kind: 'agent',
        sender_id: params[3],
        sender_name: params[4],
        broadcast_to_channel: params[5],
      };
      state.messages.push(row);
      return [{ ...row }];
    }

    if (n.startsWith('select status, metadata from agent_jobs')) {
      return [{ status: durable.job.status, metadata: durable.job.metadata }];
    }

    // Huddle relay probing and every unrelated best-effort read are empty here.
    return [];
  }

  const db = {
    async begin(callback) {
      const predecessor = transactionTail;
      let release;
      transactionTail = new Promise((resolve) => { release = resolve; });
      await predecessor;
      const draft = {
        job: structuredClone(durable.job),
        messages: structuredClone(durable.messages),
      };
      try {
        const value = await callback({
          unsafe: (sql, params) => unsafe(draft, sql, params, true),
        });
        durable.job = draft.job;
        durable.messages = draft.messages;
        return value;
      } finally {
        release();
      }
    },
    unsafe: (sql, params) => unsafe(durable, sql, params, false),
  };

  const jobs = createAgentJobs({
    PLACEHOLDER_CONTENT_RE: '^Thinking',
    badRequest: makeBadRequest,
    forbidden: makeBadRequest,
    getDb: () => db,
    parseJsonObject,
    textFromValue: (value) => String(value ?? ''),
    slugHandle: (value) => String(value || '').toLowerCase(),
    ensureTable: (table) => table,
    notifyDbSubscribers: () => {},
    scheduleTaskQueueDrain: () => {},
    logMessageActivity: async () => {},
    mirrorAgentReplyToTaskComment: async () => {},
    continueConversation: async () => {},
    touchMcpPresence: () => {},
  });

  return { ...jobs, durable, calls };
}

function submit(jobs, responseText = 'the durable answer') {
  return jobs.submitMcpJobResult({
    workspaceId: WORKSPACE_ID,
    agentId: AGENT_ID,
    jobId: JOB_ID,
    responseText,
  });
}

test('a late MCP result cannot resurrect a reaper-terminal error or append another transcript', async () => {
  const failureMessage = {
    id: '00000000-0000-4000-9000-000000000001',
    session_id: SESSION_ID,
    content: '@q failed: the MCP client stopped responding',
  };
  const jobs = makeHarness({ status: 'error', messages: [failureMessage] });

  await assert.rejects(() => submit(jobs, 'late success'), /job is error, not awaiting a result/i);

  assert.equal(jobs.durable.job.status, 'error');
  assert.equal(jobs.durable.messages.length, 1);
  assert.deepEqual(jobs.durable.messages[0], failureMessage);
  assert.equal(
    jobs.calls.some((call) => call.n.startsWith('update agent_jobs set status = $2')),
    false,
    'a terminal diagnostic read must never become write authority',
  );
  assert.equal(
    jobs.calls.some((call) => call.n.startsWith('insert into messages')),
    false,
    'the reaper transcript remains the one terminal transcript',
  );
});

test('competing no-placeholder MCP submissions commit one terminal state and one transcript', async () => {
  const jobs = makeHarness();
  const settled = await Promise.allSettled([
    submit(jobs),
    submit(jobs),
  ]);

  assert.equal(settled.filter((entry) => entry.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((entry) => entry.status === 'rejected').length, 1);
  assert.match(
    String(settled.find((entry) => entry.status === 'rejected').reason?.message || ''),
    /job is done, not awaiting a result/i,
  );
  assert.equal(jobs.durable.job.status, 'done');
  assert.equal(jobs.durable.messages.length, 1);
  assert.equal(jobs.durable.messages[0].content, 'the durable answer');

  await assert.rejects(() => submit(jobs), /job is done, not awaiting a result/i);
  assert.equal(jobs.durable.messages.length, 1, 'a later transport retry is also transcript-idempotent');
  assert.equal(
    jobs.calls.filter((call) => call.n.startsWith('insert into messages')).length,
    1,
    'only the transaction that won the running-job lock reaches the unkeyed insert',
  );
});

test('a no-placeholder transcript fault rolls the job back so one retry can finalize it once', async () => {
  const jobs = makeHarness({ failMessageInserts: 1 });

  await assert.rejects(() => submit(jobs), /transient transcript insert failure/);
  assert.equal(jobs.durable.job.status, 'running', 'the terminal CAS rolls back with the transcript insert');
  assert.equal(jobs.durable.messages.length, 0);

  assert.deepEqual(await submit(jobs), { jobId: JOB_ID, status: 'done' });
  assert.equal(jobs.durable.job.status, 'done');
  assert.equal(jobs.durable.messages.length, 1);
  assert.equal(jobs.durable.messages[0].content, 'the durable answer');
});
