// ============================================================================
// tests/agent-jobs-stop-reason.test.cjs
// ----------------------------------------------------------------------------
// Structured stop reasons (agent-runtime review, item A). The Claude Agent SDK has
// always told the daemon WHY a turn ended — stop_reason, terminal_reason,
// permission_denials, usage, total_cost_usd — and the daemon read only
// `subtype` and binned the rest, so everything downstream saw one opaque error
// string. The daemon now forwards a reason on the agent_job_result frame.
//
// That reason is a websocket string from someone else's machine that ends up
// RENDERED INTO A HUMAN'S TRANSCRIPT, so the guarantees pinned here are:
//   1. It is matched against a closed enum. Never a passthrough.
//   2. A result with no reason produces byte-identical metadata to before, so
//      an old daemon against this server behaves exactly as it does today.
//   3. finalizeStuckJob records why it reaped a job AND still writes the
//      constraint-valid status='error' ('failed' throws, and the swallowed
//      throw is what wedged a DM indefinitely — see burst-job-liveness).
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const ALL_REASONS = [
 'completed', 'cancelled', 'max_tokens', 'max_turns', 'max_budget', 'refused',
 'idle_timeout', 'hard_timeout', 'permission_denied', 'agent_error', 'connection_lost',
];

test('normalizeStopReason accepts every enum member and nothing else', () => {
 for (const reason of ALL_REASONS) {
  assert.equal(__test.normalizeStopReason(reason), reason, `${reason} is a real reason`);
 }
});

test('normalizeStopReason drops hostile and malformed input rather than storing it', () => {
 const hostile = [
  '<img src=x onerror=alert(1)>',
  'COMPLETED',
  'completed; drop table agent_jobs',
  'completed ',
  ' completed',
  '',
  null,
  undefined,
  0,
  42,
  {},
  [],
  ['completed'],
  { stopReason: 'completed' },
  'x'.repeat(10_000),
  'completed\ncancelled',
 ];
 for (const value of hostile) {
  assert.equal(__test.normalizeStopReason(value), '', `${JSON.stringify(value)} must not survive validation`);
 }
});

test('stopResultMetadata keeps only what it recognises, and caps the numbers', () => {
 const meta = __test.stopResultMetadata({
  stopReason: 'max_turns',
  stopDetail: 'error_max_turns',
  numTurns: 7,
  costUsd: 1.25,
  permissionDenials: 2,
  usage: {
   input_tokens: 100,
   output_tokens: 20,
   cache_creation_input_tokens: 5,
   cache_read_input_tokens: 40,
   evil: 999,
  },
  // Not in the accepted set: an attacker-chosen key must not reach the row.
  responseMessageId: 'attacker-controlled',
  mode: 'farm',
 });
 assert.deepEqual(meta, {
  stopReason: 'max_turns',
  stopDetail: 'error_max_turns',
  numTurns: 7,
  costUsd: 1.25,
  permissionDenials: 2,
  usage: {
   input_tokens: 100,
   output_tokens: 20,
   cache_creation_input_tokens: 5,
   cache_read_input_tokens: 40,
  },
 });
});

test('daemonStopUsage drops junk and keeps only Anthropic count fields', () => {
 assert.equal(__test.daemonStopUsage(null), null);
 assert.equal(__test.daemonStopUsage({}), null);
 assert.equal(__test.daemonStopUsage({ usage: { input_tokens: 0, output_tokens: -1 } }), null);
 assert.deepEqual(
  __test.daemonStopUsage({ usage: { input_tokens: 12.7, output_tokens: '3', secret: 'x' } }),
  { input_tokens: 13, output_tokens: 3 },
 );
});

test('stopResultMetadata rejects a detail that is not a plain token, and clamps numbers', () => {
 const injected = __test.stopResultMetadata({
  stopReason: 'agent_error',
  stopDetail: '<script>alert(1)</script>',
 });
 assert.equal(injected.stopReason, 'agent_error');
 assert.equal(injected.stopDetail, undefined, 'a detail with markup in it is dropped, not stored');

 const absurd = __test.stopResultMetadata({
  stopReason: 'completed',
  numTurns: Number.MAX_SAFE_INTEGER,
  costUsd: 1e12,
  permissionDenials: -5,
 });
 assert.equal(absurd.numTurns, 100_000);
 assert.equal(absurd.costUsd, 10_000);
 assert.equal(absurd.permissionDenials, undefined, 'a negative count is not a count');

 const notNumbers = __test.stopResultMetadata({ stopReason: 'completed', numTurns: 'lots', costUsd: 'free' });
 assert.deepEqual(notNumbers, { stopReason: 'completed' }, 'non-numeric values are omitted, never NaN');
});

// THE BACKWARD-COMPATIBILITY PIN. An old daemon sends no stopReason; a daemon
// running LocalExecutor cannot produce one. Either way the row must look exactly
// as it did before this feature existed.
test('a result frame with NO stopReason produces no stop metadata at all', () => {
 for (const frame of [{}, { stopReason: '' }, { stopDetail: 'x', numTurns: 5, costUsd: 3 }, null, undefined]) {
  assert.deepEqual(__test.stopResultMetadata(frame), {}, 'absent means unknown, and unknown writes nothing');
 }
});

test('finalizeAgentJobResult persists a validated stop reason as an OBJECT bind', async () => {
 const updates = [];
 const usageInserts = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('update agent_jobs set status')) {
    updates.push(params);
    return [{ id: 'job-1', workspace_id: 'w1', agent_id: 'a1', session_id: null, metadata: params[4] }];
   }
   if (n.includes('insert into usage_events')) {
    usageInserts.push(params);
    return [];
   }
   return [];
  },
 });

 await __test.finalizeAgentJobResult(
  // session_id null: this test is about the ROW, so it returns before touching
  // messages/activity. The chat sentence has its own test below.
  { id: 'job-1', workspace_id: 'w1', agent_id: 'a1', session_id: null, metadata: { handle: 'scout' } },
  {
   errorText: 'claude-agent-sdk result error: error_max_turns',
   resultStop: {
    stopReason: 'max_turns',
    stopDetail: 'error_max_turns',
    costUsd: 0.5,
    model: 'claude-opus-5',
    usage: { input_tokens: 100, output_tokens: 20 },
   },
  },
 );

 assert.equal(updates.length, 1);
 const metadataParam = updates[0][4];
 // Bound as an OBJECT, never JSON.stringify — a stringified $n::jsonb bind
 // becomes a jsonb string scalar and corrupts the column. This has bitten here.
 assert.equal(typeof metadataParam, 'object');
 assert.ok(!Array.isArray(metadataParam));
 assert.equal(metadataParam.stopReason, 'max_turns');
 assert.equal(metadataParam.stopDetail, 'error_max_turns');
 assert.equal(metadataParam.costUsd, 0.5);
 assert.deepEqual(metadataParam.usage, { input_tokens: 100, output_tokens: 20 });
 // Pre-existing metadata survives the merge.
 assert.equal(metadataParam.handle, 'scout');
 // Daemon token counts land in usage_events (counts, never dollars).
 assert.equal(usageInserts.length, 1);
 assert.equal(usageInserts[0][0], 'w1'); // workspace_id
 assert.equal(usageInserts[0][1], 'anthropic');
 assert.equal(usageInserts[0][2], 'claude-opus-5');
 assert.equal(usageInserts[0][3], 'agent_job');
 assert.equal(usageInserts[0][5], 100); // input
 assert.equal(usageInserts[0][6], 20); // output
});

test('finalizeAgentJobResult does not invent a usage_events row without token counts', async () => {
 const usageInserts = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('update agent_jobs set status')) {
    return [{ id: 'job-1', workspace_id: 'w1', agent_id: 'a1', session_id: null, metadata: params[4] }];
   }
   if (n.includes('insert into usage_events')) {
    usageInserts.push(params);
    return [];
   }
   return [];
  },
 });

 await __test.finalizeAgentJobResult(
  { id: 'job-1', workspace_id: 'w1', agent_id: 'a1', session_id: null, metadata: {} },
  { resultStop: { stopReason: 'completed', costUsd: 1.5, model: 'claude-opus-5' } },
 );

 assert.equal(usageInserts.length, 0, 'costUsd alone is not enough — counts only');
});

test('finalizeAgentJobResult ignores a stop reason it does not recognise', async () => {
 const updates = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('update agent_jobs set status')) {
    updates.push(params);
    return [{ id: 'job-1', session_id: null }];
   }
   return [];
  },
 });

 await __test.finalizeAgentJobResult(
  { id: 'job-1', workspace_id: 'w1', agent_id: 'a1', session_id: null, metadata: {} },
  { errorText: 'boom', resultStop: { stopReason: 'totally_made_up', stopDetail: 'nope' } },
 );

 assert.equal(updates[0][4].stopReason, undefined, 'an unknown reason is dropped, not stored');
 assert.equal(updates[0][4].stopDetail, undefined, 'and its detail goes with it');
});

test('the chat sentence explains the reason instead of echoing SDK jargon', () => {
 // A reason whose raw text is pure jargon: the sentence replaces it.
 assert.equal(
  __test.failureSentence('max_turns', 'claude-agent-sdk result error: error_max_turns'),
  'it used up its allowed steps for one turn',
 );
 assert.equal(
  __test.failureSentence('hard_timeout', 'timed out after 1800000ms'),
  'it hit the maximum time allowed for one turn',
 );
 // A reason whose raw text carries real information: the sentence LEADS and the
 // detail follows. Losing the detail here would lose the only useful part.
 assert.equal(
  __test.failureSentence('agent_error', 'ENOENT: no such file'),
  'the coding agent errored — ENOENT: no such file',
 );
 // No reason reported: byte-identical to today.
 assert.equal(__test.failureSentence('', 'raw error text'), 'raw error text');
 assert.equal(__test.failureSentence(undefined, 'raw error text'), 'raw error text');
 // An unknown reason cannot smuggle text into the transcript.
 assert.equal(__test.failureSentence('<script>', 'raw error text'), 'raw error text');
});

test('every stop reason has a distinct, non-empty human sentence', () => {
 const sentences = ALL_REASONS
  .filter((reason) => reason !== 'completed') // a completed turn has no failure sentence
  .map((reason) => __test.failureSentence(reason, ''));
 for (const sentence of sentences) assert.ok(sentence.length > 0);
 assert.equal(new Set(sentences).size, sentences.length, 'two reasons must never read the same');
});

test('finalizeStuckJob records WHY it reaped the job — and still writes status=error', async () => {
 const updates = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('update agent_jobs set status')) {
    updates.push({ n, params });
    return [{ id: 'job-1' }];
   }
   return [];
  },
 });

 await __test.finalizeStuckJob(
  { id: 'job-1', session_id: 's1', metadata: { handle: 'scout' } },
  'the daemon disconnected',
  'connection_lost',
 );

 assert.equal(updates.length, 1);
 // NOT redundant with burst-job-liveness: this write now carries a third bind,
 // and 'failed' is outside the status CHECK constraint. The resulting throw is
 // swallowed, which leaves the job 'running' forever and wedges the DM.
 assert.match(updates[0].n, /status = 'error'/);
 assert.doesNotMatch(updates[0].n, /'failed'/);
 const metadataParam = updates[0].params[2];
 assert.equal(typeof metadataParam, 'object');
 assert.equal(metadataParam.stopReason, 'connection_lost');
 assert.equal(metadataParam.handle, 'scout', 'existing metadata is merged, not replaced');
});

test('finalizeStuckJob tells the human which kind of stop it was', async () => {
 const messageWrites = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('update agent_jobs set status')) return [{ id: 'job-1' }];
   if (n.startsWith('update messages set content')) {
    messageWrites.push(params[1]);
    return [];
   }
   return [];
  },
 });

 await __test.finalizeStuckJob(
  { id: 'job-1', session_id: 's1', metadata: { handle: 'scout', responseMessageId: 'msg-1' } },
  'timed out',
  'idle_timeout',
 );

 assert.equal(messageWrites.length, 1);
 assert.match(messageWrites[0], /produced nothing for several minutes/);
 assert.match(messageWrites[0], /@scout/);
});

test('finalizeStuckJob falls back to the old wording when the reason is unusable', async () => {
 const messageWrites = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('update agent_jobs set status')) return [{ id: 'job-1' }];
   if (n.startsWith('update messages set content')) {
    messageWrites.push(params[1]);
    return [];
   }
   return [];
  },
 });

 await __test.finalizeStuckJob(
  { id: 'job-1', session_id: 's1', metadata: { handle: 'scout', responseMessageId: 'msg-1' } },
  'timed out',
  'not_a_real_reason',
 );

 assert.equal(messageWrites.length, 1);
 assert.match(messageWrites[0], /@scout stopped responding \(timed out\)/);
});

// --- Item B: the two deadlines are two DIFFERENT answers ---------------------
//
// The server's reaper fires for two unrelated conditions — a job that went
// silent, and one that ran past the absolute ceiling — and reported the single
// word "timed out" for both. They need different answers from a human: one is
// "your agent is wedged", the other is "your turn was too big".

test('reapStuckAgentJobs distinguishes a SILENT job from one that hit the ceiling', async () => {
 const finalized = [];
 const now = Date.now();
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('select * from agent_jobs')) {
    // The reaper's windows are bound, not inlined, so they can be named
    // constants that the daemon's 9-minute idle deadline is paired against.
    assert.deepEqual(params, [10, 30, 31], 'idle / hard-ceiling / farm windows');
    return [
     // Running only 5 minutes: it cannot have hit the 30-minute ceiling, so
     // the reaper caught it for SILENCE.
     { id: 'silent-1', session_id: null, metadata: {}, started_at: new Date(now - 5 * 60_000).toISOString() },
     // Running 45 minutes: the ceiling.
     { id: 'ceiling-1', session_id: null, metadata: {}, started_at: new Date(now - 45 * 60_000).toISOString() },
    ];
   }
   if (n.startsWith('update agent_jobs set status')) {
    finalized.push({ id: params[0], stopReason: params[2].stopReason });
    return [{ id: params[0] }];
   }
   return [];
  },
 });

 await __test.reapStuckAgentJobs();

 assert.deepEqual(finalized, [
  { id: 'silent-1', stopReason: 'idle_timeout' },
  { id: 'ceiling-1', stopReason: 'hard_timeout' },
 ]);
});

test('reapStuckAgentJobs survives a job with no started_at rather than throwing', async () => {
 const finalized = [];
 __test.setTestDb({
  async unsafe(sql, params) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   if (n.startsWith('select * from agent_jobs')) {
    return [{ id: 'no-start', session_id: null, metadata: {}, started_at: null }];
   }
   if (n.startsWith('update agent_jobs set status')) {
    finalized.push({ id: params[0], stopReason: params[2].stopReason });
    return [{ id: params[0] }];
   }
   return [];
  },
 });

 await __test.reapStuckAgentJobs();

 // Unknowable elapsed time: the honest answer is "it went quiet", not "it ran
 // for thirty minutes", which we cannot know.
 assert.deepEqual(finalized, [{ id: 'no-start', stopReason: 'idle_timeout' }]);
});
