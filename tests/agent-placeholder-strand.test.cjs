// ============================================================================
// tests/agent-placeholder-strand.test.cjs
// ----------------------------------------------------------------------------
// STRANDED "Thinking …" PLACEHOLDERS (2026-07).
//
// A thread hours old still showed two chips reading `Thinking 2m 11s` and
// `Thinking 2m 23s` in the LIVE style, with zero queued or running agent_jobs
// behind them. 60 such rows had accumulated, and they were still arriving.
//
// They are rotated placeholders. A segmented turn (handleAgentJobSegment) hands
// its current placeholder the finished text block and reserves a fresh id for the
// next one; only that CURRENT id is tracked in agent_jobs.metadata. Three things
// let one fall out of that chain and freeze mid-sentence:
//
//   1. The delta pump and the step handler both READ metadata, merge, and write
//      the whole object back. A tick that read the job a moment before a segment
//      rotated the placeholder put the OLD id back — and the next liveness tick
//      then streamed "Thinking Ns" straight over the text block the segment had
//      only just finalised. The reply was destroyed and its placeholder stranded
//      in one move. Both writes are now compare-and-set on responseMessageId.
//   2. The lazily-created placeholder is meant to be materialised by "the first
//      delta that actually has text for it". The guard for that was missing, so a
//      content-free heartbeat tick minted the row as "Thinking Ns" — re-creating
//      the bubble lazy creation exists to prevent, and minting the row that then
//      strands. A content-free tick may now only refresh a row that is STILL a
//      placeholder; it can neither create one nor overwrite words on screen.
//   3. Nothing swept. Every terminal path resolved the ONE placeholder the job was
//      tracking and left any earlier one standing. clearStrandedPlaceholders now
//      runs from both terminal funnels — finalizeAgentJobResult (daemon result,
//      MCP submit, MCP reaper) and finalizeStuckJob (timeout, dropped daemon,
//      phantom cleanup, startup reconcile).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');

const source = require('./helpers/fly-lane.cjs').flyLaneSource();

const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Coder', handle: 'coder' };

function agentWs() {
  return { agentAuth: AUTH, agentConnectionId: 'conn-1' };
}

function bodyOf(fnName) {
  const from = source.indexOf(`async function ${fnName}`);
  assert.notEqual(from, -1, `expected ${fnName} to exist`);
  const handler = source.slice(from);
  return handler.slice(0, handler.indexOf('\n}\n'));
}

test.afterEach(() => __test.resetTestState());

// --- the sweep -------------------------------------------------------------

test('clearStrandedPlaceholders deletes leftovers scoped to this agent, session and turn', async () => {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('delete from messages')) {
        return [{ id: 'stranded-1', session_id: 'session-1', content: 'Thinking 2m 11s' }];
      }
      return [];
    },
  });

  await __test.clearStrandedPlaceholders({
    id: 'job-1',
    agent_id: 'agent-1',
    session_id: 'session-1',
    started_at: '2026-07-25T12:29:01.732Z',
  });

  const del = calls.find((c) => c.n.startsWith('delete from messages'));
  assert.ok(del, 'a sweep was issued');
  assert.deepEqual(del.params.slice(0, 2), ['session-1', 'agent-1'], 'scoped to this session and agent');
  assert.equal(del.params[2], __test.PLACEHOLDER_CONTENT_RE, 'matches only the shapes the server writes');
  assert.equal(del.params[3], '2026-07-25T12:29:01.732Z', 'the window opens at this turn, not at the session');
  // A tool step is a separate row kind and must never be swept away with the
  // placeholders — the chips are the record of what the agent actually did.
  assert.match(del.n, /coalesce\(message_kind, ''\) = ''/);
  assert.match(del.n, /sender_kind = 'agent'/);
});

test('the sweep holds back the row the caller already resolved itself', async () => {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      calls.push({ n: String(sql).replace(/\s+/g, ' ').trim(), params });
      return [];
    },
  });

  await __test.clearStrandedPlaceholders(
    { id: 'job-1', agent_id: 'agent-1', session_id: 'session-1', started_at: '2026-07-25T12:29:01.732Z' },
    'msg-reply',
  );

  const del = calls.find((c) => c.n.startsWith('delete from messages'));
  // The tracked placeholder now holds the real reply. On the day an agent opens
  // one with "Thinking 5s" it would otherwise match the pattern and be deleted.
  assert.equal(del.params[4], 'msg-reply');
  assert.match(del.n, /id::text <> \$5::text/);
});

test('a farm/control-plane job has no conversation to sweep', async () => {
  let queried = false;
  __test.setTestDb({
    async unsafe() { queried = true; return []; },
  });

  await __test.clearStrandedPlaceholders({ id: 'job-1', agent_id: 'agent-1', session_id: null, started_at: new Date().toISOString() });
  await __test.clearStrandedPlaceholders({ id: 'job-2', agent_id: 'agent-1', session_id: 'session-1', started_at: null });
  assert.equal(queried, false, 'nothing to sweep, nothing queried');
});

test('a sweep that throws cannot fail the job that was finishing cleanly', async () => {
  __test.setTestDb({
    async unsafe() { throw new Error('messages table is on fire'); },
  });
  await __test.clearStrandedPlaceholders({
    id: 'job-1', agent_id: 'agent-1', session_id: 'session-1', started_at: new Date().toISOString(),
  });
});

// --- the terminal paths ----------------------------------------------------

test('a job that dies leaves an honest failure AND no leftover placeholders', async () => {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('update agent_jobs set status')) return [{ id: 'job-1' }];
      if (n.startsWith('update messages set content')) {
        return [{ id: 'msg-current', session_id: 'session-1', content: params[1] }];
      }
      return [];
    },
  });

  await __test.finalizeStuckJob({
    id: 'job-1',
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    session_id: 'session-1',
    started_at: '2026-07-25T12:29:01.732Z',
    metadata: { handle: 'coder', responseMessageId: 'msg-current' },
  }, 'the backend restarted');

  const rewrite = calls.find((c) => c.n.startsWith('update messages set content'));
  assert.ok(rewrite, 'the tracked placeholder was rewritten');
  assert.match(rewrite.params[1], /^@coder stopped responding \(the backend restarted\)/);
  // "Thinking 2m 11s" is a claim about the present tense; the failure is the truth.
  assert.doesNotMatch(rewrite.params[1], /^Thinking/);

  const del = calls.find((c) => c.n.startsWith('delete from messages'));
  assert.ok(del, 'the turn\'s earlier placeholders were swept too');
  assert.equal(del.params[4], 'msg-current', 'except the one that now carries the failure');
});

test('a job with no tracked placeholder still sweeps whatever it left behind', async () => {
  // The rotation chain means "no responseMessageId" does NOT mean "no placeholder
  // rows" — the early return that used to sit here skipped the sweep entirely.
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('update agent_jobs set status')) return [{ id: 'job-1' }];
      return [];
    },
  });

  await __test.finalizeStuckJob({
    id: 'job-1', workspace_id: 'ws-1', agent_id: 'agent-1', session_id: 'session-1',
    started_at: '2026-07-25T12:29:01.732Z', metadata: {},
  }, 'timed out');

  assert.ok(calls.some((c) => c.n.startsWith('delete from messages')), 'the sweep still ran');
});

test('finalizing a real result sweeps the placeholders the turn rotated past', async () => {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('update agent_jobs set status')) {
        return [{ id: 'job-1', status: params[1], session_id: 'session-1' }];
      }
      if (n.startsWith('update messages set content')) {
        return [{ id: 'msg-current', session_id: 'session-1', content: params[1] }];
      }
      return [];
    },
  });

  await __test.finalizeAgentJobResult({
    id: 'job-1', workspace_id: 'ws-1', agent_id: 'agent-1', session_id: 'session-1',
    agent_name: 'Coder', agent_handle: 'coder',
    started_at: '2026-07-25T12:29:01.732Z',
    metadata: { mode: 'daemon', handle: 'coder', responseMessageId: 'msg-current' },
  }, { responseText: '## Done — merged 27e83ba' });

  const del = calls.find((c) => c.n.startsWith('delete from messages'));
  assert.ok(del, 'a completed turn tidies up after itself');
  assert.equal(del.params[0], 'session-1');
  assert.equal(del.params[4], 'msg-current', 'the row now holding the reply is protected');
});

// --- the delta pump --------------------------------------------------------

const DELTA_JOB = {
  id: 'job-1', workspace_id: 'ws-1', agent_id: 'agent-1', session_id: 'session-1',
  agent_name: 'Coder', agent_handle: 'coder',
  metadata: { mode: 'daemon', responseMessageId: 'msg-pending', pendingPlaceholder: true, pendingPlaceholderParentId: 'thread-1' },
};

function installDeltaDb({ job = DELTA_JOB, messageUpdateMatches = false } = {}) {
  const calls = [];
  __test.setTestDb({
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select j.*, a.name as agent_name')) return [job];
      if (n.startsWith('update agent_jobs set response')) return [{ id: 'job-1' }];
      if (n.startsWith('update messages set content')) {
        return messageUpdateMatches ? [{ id: 'msg-pending', session_id: 'session-1', content: params[1] }] : [];
      }
      if (n.startsWith('insert into messages')) return [{ id: params[0], session_id: params[1], content: params[2] }];
      return [];
    },
  });
  return calls;
}

test('a content-free liveness tick never mints a "Thinking Ns" row', async () => {
  const calls = installDeltaDb();

  await __test.handleAgentJobDelta(agentWs(), { jobId: 'job-1', content: '', elapsedMs: 131000 });

  const inserts = calls.filter((c) => c.n.startsWith('insert into messages'));
  assert.deepEqual(inserts, [], 'the lazy placeholder waits for text, as its own comment promises');
});

test('a tick that carries text still materialises the block it was reserved for', async () => {
  const calls = installDeltaDb();

  await __test.handleAgentJobDelta(agentWs(), { jobId: 'job-1', content: 'Pushed. Now clean up the worktree.', elapsedMs: 131000 });

  const insert = calls.find((c) => c.n.startsWith('insert into messages'));
  assert.ok(insert, 'text arriving for a reserved placeholder writes the row');
  assert.equal(insert.params[0], 'msg-pending');
  assert.equal(insert.params[2], 'Pushed. Now clean up the worktree.');
  assert.equal(insert.params[3], 'thread-1', 'in the place the segment reserved for it');
});

test('a content-free tick may only refresh a row that is still a placeholder', async () => {
  const calls = installDeltaDb({ messageUpdateMatches: true });

  await __test.handleAgentJobDelta(agentWs(), { jobId: 'job-1', content: '', elapsedMs: 131000 });

  const update = calls.find((c) => c.n.startsWith('update messages set content'));
  assert.ok(update);
  assert.equal(update.params[1], 'Thinking 2m 11s');
  assert.match(update.n, /\$6::boolean or content ~ \$7/);
  assert.equal(update.params[5], false, 'no text — the guard is armed');
  assert.equal(update.params[6], __test.PLACEHOLDER_CONTENT_RE);
});

test('a tick that carries text owns the row and disarms the guard', async () => {
  const calls = installDeltaDb({ messageUpdateMatches: true });

  await __test.handleAgentJobDelta(agentWs(), { jobId: 'job-1', content: 'Type-check passed clean.', elapsedMs: 900 });

  const update = calls.find((c) => c.n.startsWith('update messages set content'));
  assert.equal(update.params[1], 'Type-check passed clean.');
  assert.equal(update.params[5], true, 'streaming text overwrites whatever is there');
});

// --- the compare-and-set ---------------------------------------------------

test('the delta pump cannot revert a placeholder rotation it did not see', () => {
  const body = bodyOf('handleAgentJobDelta');
  // Wholesale object write (kept — it self-heals a corrupted column), so the
  // guard is what stops a stale read putting the old placeholder id back.
  assert.match(body, /metadata = \$3::jsonb/);
  assert.match(body, /coalesce\(metadata->>'responseMessageId', ''\) = \$4/);
  // A column corrupted into a jsonb string scalar reads NULL for every key, so a
  // strict comparison would wedge the one job that most needs repairing.
  assert.match(body, /jsonb_typeof\(metadata\) <> 'object'/);
});

test('a tool step cannot revert a placeholder rotation it did not see', () => {
  const body = bodyOf('handleAgentJobStep');
  assert.match(body, /metadata = \$2::jsonb/);
  assert.match(body, /coalesce\(metadata->>'responseMessageId', ''\) = \$3/);
  assert.match(body, /jsonb_typeof\(metadata\) <> 'object'/);
});

test('the lazy placeholder is materialised by text, never by a clock', () => {
  const body = bodyOf('handleAgentJobDelta');
  assert.match(body, /metadata\.pendingPlaceholder && deltaText/);
});

test('both terminal funnels sweep, and the placeholder pattern is shared', () => {
  assert.match(bodyOf('finalizeStuckJob'), /clearStrandedPlaceholders\(job, responseMessageId\)/);
  assert.match(bodyOf('finalizeAgentJobResult'), /clearStrandedPlaceholders\(job, responseMessageId\)/);
  // One pattern, so a shape that can be written can always be recognised again.
  assert.equal(__test.PLACEHOLDER_CONTENT_RE, '^Thinking( [0-9]|…)');
  // Narrower than a bare ^Thinking: an agent reply that opens with the word is
  // not a placeholder and must never be rewritten or swept as one.
  assert.ok(!/content ~ '\^Thinking '/.test(source), 'no hand-rolled placeholder pattern is left behind');
});
