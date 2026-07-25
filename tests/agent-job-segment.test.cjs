// ============================================================================
// tests/agent-job-segment.test.cjs
// ----------------------------------------------------------------------------
// An agent turn is [text][tool][text][tool][text]. The delta pump owns ONE
// placeholder for the whole turn, so every text block was concatenated into a
// single ever-growing bubble ("…Now let's make all the edits:Now remove the
// dialog:Now the prop signature:") with no boundary the human could read or
// steer between. `agent_job_segment` rotates that placeholder: the finished
// block becomes a normal message and a FRESH placeholder takes its place.
//
// The invariants pinned here:
//   1. A segment is authenticated exactly like a step/delta — the job is loaded
//      with `agent_id = $2 and workspace_id = $3` from ws.agentAuth, so a
//      segment can never be written across agents or workspaces.
//   2. A valid segment finalises the current placeholder with the block text and
//      inserts a new placeholder with the SAME thread_parent_id, read off the
//      finalised row (inside a thread the placeholder is itself a reply).
//   3. agent_jobs.metadata is bound as an OBJECT (a stringified bind becomes a
//      jsonb string scalar and corrupts the column) and now points
//      responseMessageId at the new placeholder.
//   4. A turn that ends on a segment leaves NO orphan "Thinking …" bubble, and a
//      turn with no tools at all produces exactly ONE message.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Coder', handle: 'coder' };

function agentWs(auth = AUTH) {
  return { agentAuth: auth, agentConnectionId: 'conn-1' };
}

function makeJob(overrides = {}) {
  return {
    id: 'job-1',
    agent_id: 'agent-1',
    workspace_id: 'ws-1',
    session_id: 'session-1',
    status: 'running',
    agent_name: 'Coder',
    agent_handle: 'coder',
    metadata: { mode: 'daemon', threadParentId: null, responseMessageId: 'msg-placeholder' },
    ...overrides,
  };
}

function placeholderRow(overrides = {}) {
  return {
    id: 'msg-placeholder',
    session_id: 'session-1',
    role: 'assistant',
    content: 'Thinking 0s',
    thread_parent_id: null,
    sender_kind: 'agent',
    sender_id: 'agent-1',
    sender_name: 'Coder',
    ...overrides,
  };
}

// A fake pg that actually KEEPS the messages it is told to write, so a test can
// assert on the end state of the conversation (e.g. "no Thinking row survives")
// rather than only on the SQL that flew past. The job row is mutated in place so
// a segment's metadata write is visible to the next segment and to the result.
function installDb({ job = makeJob(), messages = [placeholderRow()] } = {}) {
  const calls = [];
  const store = new Map(messages.map((row) => [row.id, { ...row }]));
  let autoId = 0;
  const db = {
    calls,
    store,
    job,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select j.*, a.name as agent_name')) {
        // Mirror the real WHERE clause: a mismatched agent or workspace matches nothing.
        if (!job || params[0] !== job.id || params[1] !== job.agent_id || params[2] !== job.workspace_id) return [];
        return [job];
      }
      if (n.startsWith('update agent_jobs set updated_at')) {
        if (!['queued', 'running'].includes(job.status)) return []; // the status guard
        job.metadata = params[1];
        return [{ id: params[0] }];
      }
      if (n.startsWith('update agent_jobs set status = $2')) {
        job.status = params[1];
        return [{ ...job }];
      }
      if (n.startsWith('update messages set content = $2')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[4]) return [];
        row.content = params[1];
        row.sender_kind = 'agent';
        row.sender_id = params[2];
        row.sender_name = params[3];
        return [{ ...row }];
      }
      if (n.startsWith('insert into messages (id,')) {
        const row = {
          id: params[0],
          session_id: params[1],
          role: 'assistant',
          content: params[2],
          thread_parent_id: params[3],
          sender_kind: 'agent',
          sender_id: params[4],
          sender_name: params[5],
        };
        store.set(row.id, row);
        return [{ ...row }];
      }
      if (n.startsWith('insert into messages (session_id,')) {
        const row = {
          id: `auto-${++autoId}`,
          session_id: params[0],
          role: 'assistant',
          content: params[1],
          thread_parent_id: params[2],
          sender_kind: 'agent',
          sender_id: params[3],
          sender_name: params[4],
        };
        store.set(row.id, row);
        return [{ ...row }];
      }
      if (n.startsWith('delete from messages where id = $1 and session_id = $2')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[1]) return [];
        store.delete(params[0]);
        return [{ ...row }];
      }
      if (n.startsWith('select * from messages where id = $1 and session_id = $2')) {
        const row = store.get(params[0]);
        return row && row.session_id === params[1] ? [{ ...row }] : [];
      }
      return [];
    },
  };
  __test.setTestDb(db);
  return db;
}

function conversation(db) {
  return [...db.store.values()].map((row) => row.content);
}

test.afterEach(() => __test.resetTestState());

// --- security ---------------------------------------------------------------

test('an unregistered socket cannot post a segment', async () => {
  installDb();
  await assert.rejects(
    () => __test.handleAgentJobSegment({}, { jobId: 'job-1', text: 'hello' }),
    /Agent is not registered/,
  );
});

test('a segment for another agent is rejected and writes nothing', async () => {
  const db = installDb();
  const ws = agentWs({ ...AUTH, agentId: 'agent-2' });

  await assert.rejects(
    () => __test.handleAgentJobSegment(ws, { jobId: 'job-1', text: 'not mine' }),
    /Agent job not found/,
  );

  const lookup = db.calls.find((c) => c.n.startsWith('select j.*, a.name as agent_name'));
  assert.ok(lookup, 'the job is loaded before anything is written');
  assert.match(lookup.n, /where j\.id = \$1 and j\.agent_id = \$2 and j\.workspace_id = \$3/);
  assert.deepEqual(lookup.params, ['job-1', 'agent-2', 'ws-1']);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into messages')), 'no message row was inserted');
  assert.ok(!db.calls.some((c) => c.n.startsWith('update messages')), 'the placeholder was not touched');
  assert.ok(!db.calls.some((c) => c.n.startsWith('update agent_jobs')), 'the job was not touched');
  assert.deepEqual(conversation(db), ['Thinking 0s']);
});

test('a segment for another workspace is rejected and writes nothing', async () => {
  const db = installDb();
  const ws = agentWs({ ...AUTH, workspaceId: 'ws-other' });

  await assert.rejects(
    () => __test.handleAgentJobSegment(ws, { jobId: 'job-1', text: 'not mine' }),
    /Agent job not found/,
  );

  const lookup = db.calls.find((c) => c.n.startsWith('select j.*, a.name as agent_name'));
  assert.deepEqual(lookup.params, ['job-1', 'agent-1', 'ws-other']);
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into messages')), 'no message row was inserted');
  assert.deepEqual(conversation(db), ['Thinking 0s']);
});

// --- the rotation itself ----------------------------------------------------

test('a valid segment finalises the placeholder and opens a new one', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), {
    action: 'agent_job_segment',
    jobId: 'job-1',
    text: 'Good — createSubThread is only used inside handleCreateSubThreadFromScene.',
    elapsedMs: 1234,
  });

  const finalised = db.store.get('msg-placeholder');
  assert.equal(finalised.content, 'Good — createSubThread is only used inside handleCreateSubThreadFromScene.');
  assert.equal(finalised.sender_kind, 'agent');
  assert.equal(finalised.sender_id, 'agent-1');
  assert.equal(finalised.sender_name, 'Coder');

  const fresh = [...db.store.values()].filter((row) => row.id !== 'msg-placeholder');
  assert.equal(fresh.length, 1, 'exactly one replacement placeholder');
  assert.match(fresh[0].content, /^Thinking \d/, 'the replacement is a normal "Thinking …" placeholder');
  assert.equal(fresh[0].session_id, 'session-1');
  assert.equal(fresh[0].thread_parent_id, null, 'same thread position as the message it succeeds');

  // Subsequent deltas/segments/steps must flow into the NEW placeholder.
  const jobUpdate = db.calls.find((c) => c.n.startsWith('update agent_jobs set updated_at'));
  assert.ok(jobUpdate, 'the job metadata is refreshed');
  assert.match(jobUpdate.n, /metadata = \$2::jsonb/);
  assert.ok(!/set response/.test(jobUpdate.n), 'a segment does not rewrite the job response');
  const metadata = jobUpdate.params[1];
  assert.equal(typeof metadata, 'object', 'bound as an object — a stringified bind corrupts jsonb into a string scalar');
  assert.ok(!Array.isArray(metadata));
  assert.equal(metadata.mode, 'daemon', 'existing metadata keys are preserved');
  assert.equal(metadata.responseMessageId, fresh[0].id, 'the job now points at the new placeholder');
  assert.equal(metadata.segmentCount, 1);
  assert.equal(metadata.lastSegmentText, 'Good — createSubThread is only used inside handleCreateSubThreadFromScene.');
  assert.equal(metadata.lastSegmentMessageId, 'msg-placeholder');
  assert.equal(metadata.elapsedMs, 1234);
  // A finished text block is real output, so the stuck-job reaper must see progress.
  assert.equal(metadata.lastContentAt, metadata.lastDeltaAt);
  assert.ok(Number.isFinite(Date.parse(metadata.lastContentAt)));
});

test('the new placeholder inherits the thread parent of the message it succeeds', async () => {
  // Inside a thread the placeholder is itself a reply. The parent is read off the
  // finalised ROW, never recomputed — metadata.threadParentId is deliberately
  // wrong here to prove which source wins.
  const db = installDb({
    job: makeJob({ metadata: { mode: 'daemon', threadParentId: 'stale-parent', responseMessageId: 'msg-placeholder' } }),
    messages: [placeholderRow({ thread_parent_id: 'thread-root-1' })],
  });

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'first block', elapsedMs: 10 });

  const fresh = [...db.store.values()].filter((row) => row.id !== 'msg-placeholder');
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].thread_parent_id, 'thread-root-1', 'the replacement sits exactly where the finalised message sat');
});

test('an empty or whitespace segment is ignored and does not rotate', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: '   \n  ' });
  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1' });

  assert.ok(!db.calls.some((c) => c.n.startsWith('update agent_jobs')), 'the job was not touched');
  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into messages')), 'no replacement placeholder');
  assert.deepEqual(conversation(db), ['Thinking 0s'], 'the live placeholder is untouched');
});

test('a segment arriving after the job finished writes nothing', async () => {
  const db = installDb({ job: makeJob({ status: 'done' }) });

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'too late' });

  assert.ok(!db.calls.some((c) => c.n.startsWith('insert into messages')), 'a stale segment is not posted');
  assert.ok(!db.calls.some((c) => c.n.startsWith('update messages')), 'a stale segment does not rewrite a finished reply');
  assert.deepEqual(conversation(db), ['Thinking 0s']);
});

// --- the turn ending on a segment (no orphan "Thinking …") -------------------

test('a turn ending on a segment leaves no orphan Thinking message', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'Now the edits.', elapsedMs: 100 });
  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'Done — all three files updated.', elapsedMs: 900 });
  // The daemon's final result repeats the last block; it must not be posted twice.
  await __test.finalizeAgentJobResult(db.job, { responseText: 'Done — all three files updated.' });

  assert.deepEqual(conversation(db), ['Now the edits.', 'Done — all three files updated.']);
  assert.ok(!conversation(db).some((content) => /^Thinking /.test(content)), 'the spent placeholder was removed');
});

test('a turn with no tools at all produces exactly one message', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'Yes — that file is unused.', elapsedMs: 50 });
  await __test.finalizeAgentJobResult(db.job, { responseText: 'Yes — that file is unused.' });

  assert.deepEqual(conversation(db), ['Yes — that file is unused.']);
});

test('a result with no text after a segment still leaves no placeholder behind', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'All set.', elapsedMs: 50 });
  await __test.finalizeAgentJobResult(db.job, { responseText: '' });

  assert.deepEqual(conversation(db), ['All set.'], 'no "finished without output" bubble is added');
});

test('a tail that streamed on past the last segment still lands in the placeholder', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'Now the edits.', elapsedMs: 100 });
  await __test.finalizeAgentJobResult(db.job, { responseText: 'Everything compiles.' });

  assert.deepEqual(conversation(db), ['Now the edits.', 'Everything compiles.']);
});

test('a failed turn still reports the error in the trailing placeholder', async () => {
  const db = installDb();

  await __test.handleAgentJobSegment(agentWs(), { jobId: 'job-1', text: 'Starting the migration.', elapsedMs: 100 });
  await __test.finalizeAgentJobResult(db.job, { errorText: 'the daemon crashed' });

  assert.deepEqual(conversation(db), ['Starting the migration.', '@coder failed: the daemon crashed']);
});
