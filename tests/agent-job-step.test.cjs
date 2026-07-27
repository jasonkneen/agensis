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

const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Coder', handle: 'coder' };

function agentWs(auth = AUTH) {
  return { agentAuth: auth, agentConnectionId: 'conn-1' };
}

const JOB = {
  id: 'job-1',
  agent_id: 'agent-1',
  workspace_id: 'ws-1',
  session_id: 'session-1',
  agent_name: 'Coder',
  agent_handle: 'coder',
  metadata: { mode: 'daemon', responseMessageId: 'msg-placeholder' },
};

// Records every query so a test can assert on the SQL and the binds, and hands
// back the row shape each statement's caller expects.
function installDb({ job = JOB } = {}) {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select j.*, a.name as agent_name')) {
        // Mirror the real WHERE clause: a mismatched agent or workspace matches nothing.
        if (!job || params[0] !== job.id || params[1] !== job.agent_id || params[2] !== job.workspace_id) return [];
        return [job];
      }
      if (n.startsWith('update agent_jobs set updated_at')) return [{ id: params[0] }];
      // The reply bubble the step threads under. The mock previously answered
      // NOTHING here, so the code fell through to the unverified id and the
      // test passed because of the bug it was meant to catch — a responseMessageId
      // with no row is exactly what killed every step on
      // messages_thread_parent_id_fkey in production.
      if (n.startsWith('select thread_parent_id from messages')) {
        return params[0] === 'msg-placeholder' ? [{ thread_parent_id: null }] : [];
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
  });
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
  assert.match(lookup.n, /where j\.id = \$1 and j\.agent_id = \$2 and j\.workspace_id = \$3/);
  assert.deepEqual(lookup.params, ['job-1', 'agent-2', 'ws-1']);
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
  assert.deepEqual(lookup.params, ['job-1', 'agent-1', 'ws-other']);
  assert.ok(!calls.some((c) => c.n.startsWith('insert into messages')), 'no message row was inserted');
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
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select j.*, a.name as agent_name')) return [JOB];
      return []; // the status guard matched no row: the job is already done
    },
  });

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
