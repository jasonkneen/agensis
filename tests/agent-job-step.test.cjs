// ============================================================================
// tests/agent-job-step.test.cjs
// ----------------------------------------------------------------------------
// A daemon turn spent reading files, grepping and running bash produces NO text,
// so the delta pump (text only) left the human watching a silent "Thinking …"
// placeholder for the whole turn. `agent_job_step` fixes that: each tool call
// lands as its own message threaded under the agent's reply.
//
// The invariants pinned here:
//   1. A step is authenticated exactly like a delta — the job is loaded with
//      `agent_id = $2 and workspace_id = $3` from ws.agentAuth, so a step can
//      never be written across agents or workspaces.
//   2. A valid step INSERTS a new message (never updates the placeholder) whose
//      thread_parent_id is the job's metadata.responseMessageId.
//   3. A missing responseMessageId degrades to a top-level insert rather than
//      dropping the step on the floor.
//   4. agent_jobs.metadata is bound as an OBJECT (a stringified bind becomes a
//      jsonb string scalar and corrupts the column), and a step counts as real
//      progress for the stuck-job reaper via lastContentAt.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { createAgentJobs } = require('../server/agent-jobs.cjs');

const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Coder', handle: 'coder' };

function agentWs(auth = AUTH) {
  return { agentAuth: auth, agentConnectionId: 'conn-1' };
}

const JOB = {
  id: 'job-1',
  agent_id: 'agent-1',
  workspace_id: 'ws-1',
  session_id: 'session-1',
  connection_id: 'conn-1',
  status: 'running',
  agent_name: 'Coder',
  agent_handle: 'coder',
  metadata: { mode: 'daemon', responseMessageId: 'msg-placeholder' },
};

// Records every query so a test can assert on the SQL and the binds, and hands
// back the row shape each statement's caller expects.
function installDb({
  job = JOB,
  existingMessageIds = ['msg-placeholder', 'msg-work-thread'],
  agentEnabled = true,
  sessionDeleted = false,
  participates = true,
} = {}) {
  const calls = [];
  const db = {
    async begin(callback) {
      return callback(db);
    },
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select j.*, a.name as agent_name')) {
        // Mirror the complete current-scope proof, not merely the immutable ids.
        if (!job
          || params[0] !== job.id
          || params[1] !== job.agent_id
          || params[2] !== job.workspace_id
          || params[3] !== job.connection_id
          || job.status !== 'running'
          || !agentEnabled
          || sessionDeleted
          || !participates) return [];
        return [job];
      }
      if (n.startsWith('select status from agent_jobs')) {
        if (!job
          || params[0] !== job.id
          || params[1] !== job.agent_id
          || params[2] !== job.workspace_id
          || params[3] !== job.connection_id) return [];
        return [{ status: job.status }];
      }
      if (n.startsWith('update agent_jobs set updated_at')) {
        if (job.status !== 'running' || params[3] !== job.connection_id) return [];
        return [{ id: params[0] }];
      }
      // The reply bubble the step threads under. The mock previously answered
      // NOTHING here, so the code fell through to the unverified id and the
      // test passed because of the bug it was meant to catch — a responseMessageId
      // with no row is exactly what killed every step on
      // messages_thread_parent_id_fkey in production.
      if (n.startsWith('select thread_parent_id from messages')) {
        return params[0] === 'msg-placeholder' ? [{ thread_parent_id: null }] : [];
      }
      // verifyThreadParent's existence probe. Only ids that really live in this
      // session come back, so an unknown fallback still degrades to a flat post.
      if (n.startsWith('select id from messages where id =')) {
        return existingMessageIds.includes(params[0]) && params[1] === 'session-1'
          ? [{ id: params[0] }]
          : [];
      }
      if (n.startsWith('insert into messages')) {
        return [{
          id: 'msg-step-1',
          session_id: params[0],
          role: 'assistant',
          content: params[1],
          thread_parent_id: params[2],
          sender_kind: 'agent',
          sender_id: params[3],
          sender_name: params[4],
        }];
      }
      return [];
    },
  };
  __test.setTestDb(db);
  Object.defineProperty(calls, 'db', { value: db });
  return calls;
}

test.afterEach(() => __test.resetTestState());

test('an unregistered socket cannot post a step', async () => {
  installDb();
  await assert.rejects(
    () => __test.handleAgentJobStep({}, { jobId: 'job-1', kind: 'tool', name: 'Read' }),
    /Agent is not registered/,
  );
});

test('a step for another agent is rejected and writes nothing', async () => {
  const calls = installDb();
  const ws = agentWs({ ...AUTH, agentId: 'agent-2' });

  await assert.rejects(
    () => __test.handleAgentJobStep(ws, { jobId: 'job-1', kind: 'tool', name: 'Read', detail: 'src/App.tsx' }),
    /Agent job not found/,
  );

  const lookup = calls.find((c) => c.n.startsWith('select j.*, a.name as agent_name'));
  assert.ok(lookup, 'the job is loaded before anything is written');
  assert.match(lookup.n, /where j\.id = \$1 and j\.agent_id = \$2 and j\.workspace_id = \$3 and j\.connection_id = \$4 and j\.status = 'running'/);
  assert.match(lookup.n, /s\.deleted_at is null/);
  assert.match(lookup.n, /a\.enabled is true/);
  assert.match(lookup.n, /jsonb_array_elements/);
  assert.match(lookup.n, /for update of j, s, a/);
  assert.deepEqual(lookup.params, ['job-1', 'agent-2', 'ws-1', 'conn-1']);
  assert.ok(!calls.some((c) => c.n.startsWith('insert into messages')), 'no message row was inserted');
  assert.ok(!calls.some((c) => c.n.startsWith('update agent_jobs')), 'the job was not touched');
});

test('a step for another workspace is rejected and writes nothing', async () => {
  const calls = installDb();
  const ws = agentWs({ ...AUTH, workspaceId: 'ws-other' });

  await assert.rejects(
    () => __test.handleAgentJobStep(ws, { jobId: 'job-1', kind: 'tool', name: 'Bash', detail: 'npm test' }),
    /Agent job not found/,
  );

  const lookup = calls.find((c) => c.n.startsWith('select j.*, a.name as agent_name'));
  assert.deepEqual(lookup.params, ['job-1', 'agent-1', 'ws-other', 'conn-1']);
  assert.ok(!calls.some((c) => c.n.startsWith('insert into messages')), 'no message row was inserted');
});

test('a running daemon cannot write after its live session or agent scope is revoked', async (t) => {
  const revokedScopes = [
    ['disabled agent', { agentEnabled: false }],
    ['deleted session', { sessionDeleted: true }],
    ['removed participant', { participates: false }],
    ['replaced connection', { job: { ...JOB, connection_id: 'conn-old' } }],
  ];

  for (const [label, options] of revokedScopes) {
    await t.test(label, async () => {
      const calls = installDb(options);
      await assert.rejects(
        () => __test.handleAgentJobStep(agentWs(), {
          jobId: 'job-1', kind: 'tool', name: 'Read', detail: 'secrets.ts',
        }),
        /Agent job not found/,
      );
      assert.ok(!calls.some((c) => c.n.startsWith('insert into messages')), 'no transcript write');
      assert.ok(!calls.some((c) => c.n.startsWith('update agent_jobs')), 'no progress write');
    });
  }
});

test('every daemon-originated write path shares the current live-scope gate', async (t) => {
  const frames = [
    ['delta', (ws) => __test.handleAgentJobDelta(ws, { jobId: 'job-1', content: 'leak' })],
    ['step', (ws) => __test.handleAgentJobStep(ws, { jobId: 'job-1', kind: 'tool', name: 'Read', detail: 'secret.ts' })],
    ['segment', (ws) => __test.handleAgentJobSegment(ws, { jobId: 'job-1', text: 'leak' })],
    ['result', (ws, calls) => createAgentJobs({
      getDb: () => calls.db,
      forbidden: (message) => Object.assign(new Error(message), { status: 403 }),
      badRequest: (message) => Object.assign(new Error(message), { status: 400 }),
    }).handleAgentJobResult(ws, { jobId: 'job-1', response: 'leak' })],
  ];

  for (const [label, sendFrame] of frames) {
    await t.test(label, async () => {
      const calls = installDb({ agentEnabled: false });
      await assert.rejects(() => sendFrame(agentWs(), calls), /Agent job not found/);
      assert.ok(!calls.some((c) => c.n.startsWith('insert into messages')), 'no transcript insert');
      assert.ok(!calls.some((c) => c.n.startsWith('update messages')), 'no transcript update');
      assert.ok(!calls.some((c) => c.n.startsWith('update agent_jobs')), 'no progress or terminal write');
    });
  }
});

test('daemon result side effects run only after its locked transcript transaction commits', async () => {
  const events = [];
  let inTransaction = false;
  const job = {
    ...JOB,
    started_at: null,
    metadata: { mode: 'daemon', responseMessageId: 'msg-placeholder' },
  };
  const db = {
    async begin(callback) {
      events.push('begin');
      inTransaction = true;
      const value = await callback(db);
      inTransaction = false;
      events.push('commit');
      return value;
    },
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select status from agent_jobs')) return [{ status: 'running' }];
      if (n.startsWith('select j.*, a.name as agent_name')) return [job];
      if (n.startsWith('update agent_jobs set status = $2')) {
        events.push('terminal-write');
        return [{ ...job, status: params[1] }];
      }
      if (n.startsWith('update messages set content = $2')) {
        events.push('transcript-write');
        return [{ id: 'msg-placeholder', session_id: 'session-1', content: params[1] }];
      }
      return [];
    },
  };
  const jobs = createAgentJobs({
    getDb: () => db,
    forbidden: (message) => Object.assign(new Error(message), { status: 403 }),
    badRequest: (message) => Object.assign(new Error(message), { status: 400 }),
    parseJsonObject: (value) => (value && typeof value === 'object' ? value : {}),
    textFromValue: (value) => String(value ?? ''),
    slugHandle: (value) => String(value || '').toLowerCase(),
    notifyDbSubscribers: (table) => events.push(`fanout:${table}:${inTransaction}`),
    scheduleTaskQueueDrain: () => events.push(`drain:${inTransaction}`),
    logMessageActivity: async () => events.push(`activity:${inTransaction}`),
    mirrorAgentReplyToTaskComment: async () => events.push(`mirror:${inTransaction}`),
    continueConversation: async () => events.push(`continue:${inTransaction}`),
    updateAgentHeartbeat: async () => {},
  });

  await jobs.handleAgentJobResult(agentWs(), { jobId: 'job-1', response: 'done' });

  assert.ok(events.indexOf('terminal-write') < events.indexOf('commit'));
  assert.ok(events.indexOf('transcript-write') < events.indexOf('commit'));
  for (const effect of ['fanout:agent_jobs:false', 'fanout:messages:false', 'drain:false', 'activity:false', 'mirror:false', 'continue:false']) {
    assert.ok(events.includes(effect), `${effect} must observe committed state: ${events.join(', ')}`);
  }
  assert.ok(!events.some((event) => /:(true)$/.test(event)), `no external effect escaped before commit: ${events.join(', ')}`);
});

test('a valid step inserts a new message threaded under the job responseMessageId', async () => {
  const calls = installDb();

  await __test.handleAgentJobStep(agentWs(), {
    action: 'agent_job_step',
    jobId: 'job-1',
    kind: 'tool',
    name: 'Read',
    detail: 'src/App.tsx',
    elapsedMs: 1234,
  });

  const inserts = calls.filter((c) => c.n.startsWith('insert into messages'));
  assert.equal(inserts.length, 1, 'exactly one message row per step');
  const [sessionId, content, threadParentId, senderId, senderName] = inserts[0].params;
  assert.equal(sessionId, 'session-1');
  assert.equal(content, 'Read · src/App.tsx');
  assert.equal(threadParentId, 'msg-placeholder', 'the step nests under the agent reply');
  assert.equal(senderId, 'agent-1');
  assert.equal(senderName, 'Coder');
  assert.match(inserts[0].n, /role, content, thread_parent_id/);
  // The trailing message_kind/tool_name/tool_detail binds are pinned separately
  // in tests/message-tool-steps.test.cjs; what matters here is that the row is
  // still an agent-authored assistant message threaded under the reply.
  assert.match(inserts[0].n, /values \(\$1, 'assistant', \$2, \$3, 'agent', \$4, \$5[,)]/);

  // The placeholder must survive untouched — a step is an extra message, not an
  // edit of the reply bubble.
  assert.ok(!calls.some((c) => c.n.startsWith('update messages')), 'the placeholder was not rewritten');
});

test('a step with no responseMessageId still posts, just without a thread parent', async () => {
  const calls = installDb({ job: { ...JOB, metadata: { mode: 'daemon' } } });

  await __test.handleAgentJobStep(agentWs(), { jobId: 'job-1', kind: 'tool', name: 'Grep', detail: 'TODO' });

  const inserts = calls.filter((c) => c.n.startsWith('insert into messages'));
  assert.equal(inserts.length, 1, 'the step is not dropped');
  assert.equal(inserts[0].params[2], null, 'no thread parent rather than no message');
});

test('a step counts as progress and binds metadata as an object', async () => {
  const calls = installDb();

  await __test.handleAgentJobStep(agentWs(), { jobId: 'job-1', kind: 'tool', name: 'Bash', detail: 'npm test', elapsedMs: 900 });

  const jobUpdate = calls.find((c) => c.n.startsWith('update agent_jobs'));
  assert.ok(jobUpdate, 'the job metadata is refreshed');
  assert.match(jobUpdate.n, /metadata = \$2::jsonb/);
  // `response` belongs to the delta pump and the final result; a step must not move it.
  assert.ok(!/set response/.test(jobUpdate.n) && !/response = /.test(jobUpdate.n), 'a step does not rewrite the job response');
  const metadata = jobUpdate.params[1];
  assert.equal(typeof metadata, 'object', 'bound as an object — a stringified bind corrupts jsonb into a string scalar');
  assert.ok(!Array.isArray(metadata));
  assert.equal(metadata.mode, 'daemon', 'existing metadata keys are preserved');
  assert.equal(metadata.responseMessageId, 'msg-placeholder');
  assert.equal(metadata.elapsedMs, 900);
  // Real work happened, so the stuck-job reaper must see progress.
  assert.equal(metadata.lastContentAt, metadata.lastDeltaAt);
  assert.ok(Number.isFinite(Date.parse(metadata.lastContentAt)));
});

test('a step arriving after the job finished inserts nothing', async () => {
  const calls = installDb({ job: { ...JOB, status: 'done' } });

  await __test.handleAgentJobStep(agentWs(), { jobId: 'job-1', kind: 'tool', name: 'Read', detail: 'a.ts' });
  assert.ok(!calls.some((c) => c.n.startsWith('insert into messages')), 'a stale step is not posted');
});

test('agentStepContent renders one plain line and tolerates a missing half', () => {
  const { agentStepContent } = __test;
  assert.equal(agentStepContent({ name: 'Read', detail: 'src/App.tsx' }), 'Read · src/App.tsx');
  assert.equal(agentStepContent({ name: 'Read' }), 'Read');
  assert.equal(agentStepContent({ detail: 'src/App.tsx' }), 'src/App.tsx');
  assert.equal(agentStepContent({}), '', 'a step with nothing to say is not worth a message');
  // Multi-line tool input collapses to a single line, and long input is clipped.
  assert.equal(agentStepContent({ name: 'Bash', detail: 'npm test\n&& npm run lint' }), 'Bash · npm test && npm run lint');
  const long = agentStepContent({ name: 'Bash', detail: 'x'.repeat(400) });
  assert.ok(long.length <= 167, `expected a clipped single line, got ${long.length} chars`);
  assert.ok(long.endsWith('…'));
});

// THE PRODUCTION BUG (2026-07-29, observed live in Coder's own DM).
//
// A segment rotates the "Thinking …" placeholder on every text block, and
// clearStrandedPlaceholders removes leftovers — so on a long turn
// metadata.responseMessageId routinely points at a row that no longer exists.
// The lookup above then missed, threadParentId stayed null, and EVERY tool chip
// was posted at the DM's top level while the same turn's text sat correctly in
// the thread. Confirmed against the live rows: 12 consecutive tool_steps at
// TOP-LEVEL, interleaved with segments carrying thread_parent_id = the thread.
// The work was split across two places and the thread looked idle.
//
// handleAgentJobSegment has fallen back to metadata.workThreadParentId all
// along; the step path never got the same fallback.
test('a step whose placeholder has been rotated away still lands in the work thread', async () => {
  const calls = installDb({
    job: {
      ...JOB,
      metadata: {
        mode: 'daemon',
        // Points at a row that no longer exists — the mock answers [] for it.
        responseMessageId: 'msg-rotated-away',
        workThreadParentId: 'msg-work-thread',
      },
    },
  });

  await __test.handleAgentJobStep(agentWs(), {
    action: 'agent_job_step', jobId: 'job-1', kind: 'tool', name: 'Bash', detail: 'npx vitest run',
  });

  const insert = calls.find((c) => c.n.startsWith('insert into messages'));
  assert.ok(insert, 'the step is still written');
  assert.equal(insert.params[2], 'msg-work-thread', 'the chip belongs in the thread, not the channel root');
});

test('the work-thread fallback is verified, so an id from another session posts flat', async () => {
  const calls = installDb({
    job: {
      ...JOB,
      metadata: { mode: 'daemon', responseMessageId: 'msg-rotated-away', workThreadParentId: 'msg-elsewhere' },
    },
    existingMessageIds: ['msg-placeholder'], // 'msg-elsewhere' is not in this session
  });

  await __test.handleAgentJobStep(agentWs(), {
    action: 'agent_job_step', jobId: 'job-1', kind: 'tool', name: 'Read', detail: 'a.ts',
  });

  const insert = calls.find((c) => c.n.startsWith('insert into messages'));
  assert.ok(insert, 'an unverifiable parent must not kill the write');
  assert.equal(insert.params[2], null, 'degrades to top level rather than dying on the foreign key');
});

test('a live placeholder still wins over the work-thread fallback', async () => {
  const calls = installDb({
    job: {
      ...JOB,
      metadata: { mode: 'daemon', responseMessageId: 'msg-placeholder', workThreadParentId: 'msg-work-thread' },
    },
  });

  await __test.handleAgentJobStep(agentWs(), {
    action: 'agent_job_step', jobId: 'job-1', kind: 'tool', name: 'Grep', detail: 'x',
  });

  const insert = calls.find((c) => c.n.startsWith('insert into messages'));
  // Row-derived parent wins: the placeholder has no parent of its own, so steps
  // nest under the placeholder itself exactly as before.
  assert.equal(insert.params[2], 'msg-placeholder', 'unchanged behaviour when the placeholder is alive');
});
