const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const {
  normalizeRunMode,
  runAgentTurn,
  claimExternalJob,
  submitExternalJobResult,
  externalAgentIdsForRuntime,
  registerRuntime,
  hasExternalRuntime,
  touchExternalPresence,
  reapStuckExternalJobs,
  verifyRuntimeToken,
  verifyRuntimeJoinToken,
  verifyMcpToken,
  finalizeAgentJobResult,
  hashAgentToken,
  setTestDb,
  resetTestState,
} = __test;

const WS = 'ws-1';

// A fake postgres tag-less client. `handlers` is an ordered list of
// { match: RegExp, rows: (params, sql) => any[] }. First match wins; default [].
// Every call is recorded on db.calls for assertions.
function makeDb(handlers = []) {
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params, sql });
      for (const h of handlers) {
        if (h.match.test(n)) return typeof h.rows === 'function' ? h.rows(params, n) : (h.rows || []);
      }
      return [];
    },
  };
  return db;
}

function use(handlers) {
  const db = makeDb(handlers);
  setTestDb(db);
  return db;
}

test.afterEach(() => resetTestState());

// --- normalizeRunMode -------------------------------------------------------

test('normalizeRunMode preserves the three modes and fails safe to builtin', () => {
  assert.equal(normalizeRunMode('daemon'), 'daemon');
  assert.equal(normalizeRunMode('external'), 'external');
  assert.equal(normalizeRunMode('builtin'), 'builtin');
  assert.equal(normalizeRunMode('nonsense'), 'builtin');
  assert.equal(normalizeRunMode(undefined), 'builtin');
  assert.equal(normalizeRunMode(null), 'builtin');
});

// --- token resolvers --------------------------------------------------------

test('verifyRuntimeToken resolves an approved runtime and queries by token hash', async () => {
  const db = use([
    { match: /^select id, workspace_id, name, status from agent_runtimes where token_hash = \$1/,
      rows: () => [{ id: 'rt-1', workspace_id: WS, name: 'Cursor', status: 'approved' }] },
  ]);
  const id = await verifyRuntimeToken('agr_secret');
  assert.deepEqual(id, { kind: 'runtime', runtimeId: 'rt-1', workspaceId: WS, name: 'Cursor', status: 'approved' });
  assert.equal(db.calls[0].params[0], hashAgentToken('agr_secret'));
});

test('verifyRuntimeToken returns null for a revoked runtime and for no match', async () => {
  use([{ match: /agent_runtimes where token_hash/, rows: () => [{ id: 'rt-1', workspace_id: WS, name: 'X', status: 'revoked' }] }]);
  assert.equal(await verifyRuntimeToken('agr_x'), null);
  resetTestState();
  use([{ match: /agent_runtimes where token_hash/, rows: () => [] }]);
  assert.equal(await verifyRuntimeToken('agr_missing'), null);
  assert.equal(await verifyRuntimeToken(''), null);
});

test('verifyRuntimeJoinToken resolves a workspace + auto-approve flag', async () => {
  use([{ match: /from workspaces where runtime_join_token_hash = \$1/, rows: () => [{ id: WS, runtime_auto_approve: true }] }]);
  assert.deepEqual(await verifyRuntimeJoinToken('agj_x'), { kind: 'join', workspaceId: WS, autoApprove: true });
});

test('verifyMcpToken precedence: agent > runtime > join', async () => {
  // Agent token wins: workspace_agents lookup returns a row.
  use([
    { match: /from workspace_agents where connect_token_hash = \$1/, rows: () => [{
      id: 'agent-1', workspace_id: WS, name: 'Coder', handle: 'coder', run_mode: 'external', enabled: true,
    }] },
  ]);
  const asAgent = await verifyMcpToken('aga_x');
  assert.equal(asAgent.kind, 'agent');
  resetTestState();

  // No agent row → runtime row resolves.
  use([
    { match: /from workspace_agents where connect_token_hash/, rows: () => [] },
    { match: /from agent_runtimes where token_hash/, rows: () => [{ id: 'rt-1', workspace_id: WS, name: 'RT', status: 'approved' }] },
  ]);
  const asRuntime = await verifyMcpToken('agr_x');
  assert.equal(asRuntime.kind, 'runtime');
  resetTestState();

  // Neither → join token resolves.
  use([
    { match: /from workspace_agents where connect_token_hash/, rows: () => [] },
    { match: /from agent_runtimes where token_hash/, rows: () => [] },
    { match: /from workspaces where runtime_join_token_hash/, rows: () => [{ id: WS, runtime_auto_approve: false }] },
  ]);
  const asJoin = await verifyMcpToken('agj_x');
  assert.equal(asJoin.kind, 'join');
});

// --- registerRuntime --------------------------------------------------------

test('registerRuntime mints a pending runtime + agr_ token by default', async () => {
  let insertedParams = null;
  use([{ match: /^insert into agent_runtimes/, rows: (params) => { insertedParams = params; return [{ id: 'rt-new', workspace_id: WS, name: params[1], status: params[3] }]; } }]);
  const { runtime, token } = await registerRuntime({ workspaceId: WS, name: 'Cursor' });
  assert.equal(runtime.status, 'pending');
  assert.match(token, /^agr_/);
  // token is stored hashed, never raw
  assert.equal(insertedParams[2], hashAgentToken(token));
  assert.equal(insertedParams[3], 'pending');
});

test('registerRuntime auto-approves when asked', async () => {
  use([{ match: /^insert into agent_runtimes/, rows: (params) => [{ id: 'rt-new', workspace_id: WS, name: params[1], status: params[3] }] }]);
  const { runtime } = await registerRuntime({ workspaceId: WS, name: 'CI', autoApprove: true });
  assert.equal(runtime.status, 'approved');
});

// --- externalAgentIdsForRuntime --------------------------------------------

test('externalAgentIdsForRuntime returns mapped ids and honors the `only` handle filter', async () => {
  use([{ match: /from workspace_agents where runtime_id = \$1 and run_mode = 'external'/, rows: () => [
    { id: 'a1', handle: 'coder', name: 'Coder' },
    { id: 'a2', handle: 'scout', name: 'Scout' },
  ] }]);
  assert.deepEqual(await externalAgentIdsForRuntime('rt-1'), ['a1', 'a2']);
  resetTestState();
  use([{ match: /from workspace_agents where runtime_id = \$1 and run_mode = 'external'/, rows: () => [
    { id: 'a1', handle: 'coder', name: 'Coder' },
    { id: 'a2', handle: 'scout', name: 'Scout' },
  ] }]);
  assert.deepEqual(await externalAgentIdsForRuntime('rt-1', ['scout']), ['a2']);
  assert.deepEqual(await externalAgentIdsForRuntime(null), []);
});

// --- claimExternalJob -------------------------------------------------------

test('claimExternalJob with an empty agent set claims nothing and never runs the claim UPDATE', async () => {
  const db = use([]);
  const out = await claimExternalJob({ workspaceId: WS, agentIds: [] });
  assert.equal(out, null);
  assert.ok(!db.calls.some((c) => /update agent_jobs set status = 'running'/.test(c.n)), 'must not attempt a claim');
});

test('claimExternalJob (agent scope) issues the atomic claim and returns the job payload', async () => {
  const db = use([
    { match: /update agent_jobs set status = 'running'/, rows: (params) => [{
      id: 'job-1', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', prompt: 'do it',
      metadata: JSON.stringify({ threadParentId: null, mode: 'external' }),
    }] },
    { match: /select \* from workspace_agents where id = \$1/, rows: () => [{ id: 'a1', name: 'Coder', handle: 'coder', model: 'claude-opus-4-8', run_mode: 'external', workspace_id: WS }] },
  ]);
  const out = await claimExternalJob({ workspaceId: WS, agentIds: ['a1'] });
  assert.equal(out.jobId, 'job-1');
  assert.equal(out.prompt, 'do it');
  assert.equal(out.agent.handle, 'coder');
  const claim = db.calls.find((c) => /update agent_jobs set status = 'running'/.test(c.n));
  assert.ok(/for update skip locked/.test(claim.n), 'claim must use FOR UPDATE SKIP LOCKED');
  assert.ok(/agent_id = any\(\$2\)/.test(claim.n), 'claim must scope to agent ids');
  assert.deepEqual(claim.params, [WS, ['a1']]);
});

test('claimExternalJob (runtime scope) touches DB presence then claims', async () => {
  const db = use([
    { match: /update agent_runtimes set last_seen_at = now/, rows: () => [] },
    { match: /update agent_jobs set status = 'running'/, rows: () => [] }, // no job queued
  ]);
  const out = await claimExternalJob({ workspaceId: WS, agentIds: ['a1'], runtimeId: 'rt-1' });
  assert.equal(out, null);
  assert.ok(db.calls.some((c) => /update agent_runtimes set last_seen_at/.test(c.n)), 'runtime poll must refresh presence');
});

test('claimExternalJob swallows a presence-update failure (best effort) and still claims', async () => {
  const db = use([
    { match: /update agent_runtimes set last_seen_at = now/, rows: () => { throw new Error('presence write failed'); } },
    { match: /update agent_jobs set status = 'running'/, rows: () => [] }, // no job queued
  ]);
  // Must not throw despite the presence write blowing up.
  const out = await claimExternalJob({ workspaceId: WS, agentIds: ['a1'], runtimeId: 'rt-1' });
  assert.equal(out, null);
  assert.ok(db.calls.some((c) => /update agent_runtimes set last_seen_at/.test(c.n)));
});

// --- submitExternalJobResult ------------------------------------------------

function jobLookupHandler(job) {
  return { match: /select j\.\*, a\.name as agent_name/, rows: () => (job ? [job] : []) };
}

test('submitExternalJobResult rejects a missing job', async () => {
  use([jobLookupHandler(null)]);
  await assert.rejects(() => submitExternalJobResult({ workspaceId: WS, jobId: 'nope', responseText: 'x', agentIds: ['a1'] }), /not found/i);
});

test('submitExternalJobResult rejects a non-external job and a non-running job', async () => {
  use([jobLookupHandler({ id: 'j', workspace_id: WS, agent_id: 'a1', status: 'running', metadata: JSON.stringify({ mode: 'daemon' }) })]);
  await assert.rejects(() => submitExternalJobResult({ workspaceId: WS, jobId: 'j', responseText: 'x', agentIds: ['a1'] }), /not an external job/i);
  resetTestState();
  use([jobLookupHandler({ id: 'j', workspace_id: WS, agent_id: 'a1', status: 'done', metadata: JSON.stringify({ mode: 'external' }) })]);
  await assert.rejects(() => submitExternalJobResult({ workspaceId: WS, jobId: 'j', responseText: 'x', agentIds: ['a1'] }), /not awaiting a result/i);
});

test('submitExternalJobResult finalizes a running external job and scopes to agentIds', async () => {
  const db = use([
    jobLookupHandler({ id: 'j', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', status: 'running', agent_name: 'Coder', agent_handle: 'coder', metadata: JSON.stringify({ mode: 'external', responseMessageId: 'm-1', threadParentId: null }) }),
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j', status: 'done' }] },
    { match: /update messages set content = \$2/, rows: () => [{ id: 'm-1', session_id: 'ch-1', content: 'answer', sender_name: 'Coder' }] },
  ]);
  const out = await submitExternalJobResult({ workspaceId: WS, jobId: 'j', responseText: 'answer', agentIds: ['a1'] });
  assert.deepEqual(out, { jobId: 'j', status: 'done' });
  const lookup = db.calls.find((c) => /select j\.\*, a\.name as agent_name/.test(c.n));
  assert.ok(/j\.agent_id = any\(\$3\)/.test(lookup.n), 'lookup must scope to agentIds');
  assert.ok(db.calls.some((c) => /update messages set content = \$2/.test(c.n)), 'reply must rewrite the placeholder');
});

test('submitExternalJobResult with empty agentIds is treated as not found', async () => {
  use([]);
  await assert.rejects(() => submitExternalJobResult({ workspaceId: WS, jobId: 'j', responseText: 'x', agentIds: [] }), /not found/i);
});

// --- hasExternalRuntime -----------------------------------------------------

test('hasExternalRuntime (mapped agent) reflects DB presence of an approved runtime', async () => {
  use([{ match: /from agent_runtimes where id = \$1 and workspace_id = \$2 and status = 'approved'/, rows: () => [{ '?column?': 1 }] }]);
  assert.equal(await hasExternalRuntime({ id: 'a1', workspace_id: WS, runtime_id: 'rt-1' }), true);
  resetTestState();
  use([{ match: /from agent_runtimes where id = \$1 and workspace_id = \$2 and status = 'approved'/, rows: () => [] }]);
  assert.equal(await hasExternalRuntime({ id: 'a1', workspace_id: WS, runtime_id: 'rt-1' }), false);
});

test('hasExternalRuntime (unmapped agent) falls back to in-memory presence (false for a never-polled agent)', async () => {
  use([]);
  // A unique id that no other test has touch()ed in the process-local presence map.
  assert.equal(await hasExternalRuntime({ id: 'agent-never-polled', workspace_id: WS, runtime_id: null }), false);
});

// --- finalizeAgentJobResult -------------------------------------------------

test('finalizeAgentJobResult rewrites the Thinking placeholder with the reply', async () => {
  const db = use([
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j', status: 'done' }] },
    { match: /update messages set content = \$2/, rows: (params) => [{ id: 'm-1', session_id: 'ch-1', content: params[1], sender_name: 'Coder' }] },
  ]);
  await finalizeAgentJobResult(
    { id: 'j', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', agent_name: 'Coder', agent_handle: 'coder', metadata: JSON.stringify({ responseMessageId: 'm-1', threadParentId: null, mode: 'external' }) },
    { responseText: 'the answer' },
  );
  const msg = db.calls.find((c) => /update messages set content = \$2/.test(c.n));
  assert.equal(msg.params[1], 'the answer');
});

// --- runAgentTurn external dispatch branch ---------------------------------

// Minimal agent row + DB that satisfy runAgentTurn's context-building queries
// (which all default to [] in the fake DB) for an external-mode agent.
function externalAgent(extra = {}) {
  return {
    id: 'a1', workspace_id: WS, name: 'Coder', handle: 'coder', model: 'auto',
    run_mode: 'external', enabled: true, permission_mode: 'default',
    tools: '[]', skills: '[]', system_prompt: 'be helpful', ...extra,
  };
}

test('runAgentTurn (external, no runtime present) posts a fail-fast message and does not enqueue', async () => {
  const db = use([
    { match: /from agent_runtimes where id = \$1 and workspace_id = \$2 and status = 'approved'/, rows: () => [] },
    { match: /^insert into messages/, rows: (params) => [{ id: 'm-1', session_id: params[0], content: params[1] }] },
  ]);
  const res = await runAgentTurn(externalAgent({ runtime_id: 'rt-1' }), { workspaceId: WS, sessionId: 'ch-1' });
  assert.deepEqual(res, { ok: false, pending: false });
  const insert = db.calls.find((c) => /^insert into messages/.test(c.n));
  assert.match(insert.params[1], /no external MCP runtime|none is connected/i);
  assert.ok(!db.calls.some((c) => /^insert into agent_jobs/.test(c.n)), 'must not enqueue a job');
});

test('runAgentTurn (external, runtime present) enqueues a queued external job and returns pending', async () => {
  const db = use([
    { match: /from agent_runtimes where id = \$1 and workspace_id = \$2 and status = 'approved'/, rows: () => [{ '?column?': 1 }] },
    { match: /^insert into messages/, rows: (params) => [{ id: 'm-1', session_id: params[0], content: params[1] }] },
    { match: /^insert into agent_jobs/, rows: (params) => [{ id: 'job-1', session_id: params[2], status: 'queued' }] },
  ]);
  const res = await runAgentTurn(externalAgent({ runtime_id: 'rt-1' }), { workspaceId: WS, sessionId: 'ch-1' });
  assert.deepEqual(res, { ok: true, pending: true });
  const job = db.calls.find((c) => /^insert into agent_jobs/.test(c.n));
  assert.ok(job, 'must enqueue a job');
  // The job metadata must mark it external so claim_job can find it.
  assert.match(job.params[5], /"mode":"external"/);
  // A "Thinking" placeholder message is inserted first.
  assert.ok(db.calls.some((c) => /^insert into messages/.test(c.n)));
});

test('runAgentTurn (external, legacy unmapped agent) uses in-memory presence', async () => {
  // No runtime_id → falls back to in-memory presence. Touch it so dispatch enqueues.
  touchExternalPresence(['a-legacy']);
  const db = use([
    { match: /^insert into messages/, rows: (params) => [{ id: 'm', session_id: params[0], content: params[1] }] },
    { match: /^insert into agent_jobs/, rows: () => [{ id: 'job-2', status: 'queued' }] },
  ]);
  const res = await runAgentTurn(externalAgent({ id: 'a-legacy', runtime_id: null }), { workspaceId: WS, sessionId: 'ch-1' });
  assert.deepEqual(res, { ok: true, pending: true });
  assert.ok(db.calls.some((c) => /^insert into agent_jobs/.test(c.n)));
});

// --- reapStuckExternalJobs ---------------------------------------------------

test('reapStuckExternalJobs finalizes stale queued/running external jobs with an error', async () => {
  const db = use([
    { match: /where \(j\.metadata->>'mode'\) = 'external' and j\.status in \('queued', 'running'\)/, rows: () => [
      { id: 'j1', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', agent_name: 'Coder', agent_handle: 'coder', metadata: JSON.stringify({ responseMessageId: 'm1', mode: 'external' }) },
    ] },
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j1', status: 'error' }] },
    { match: /update messages set content = \$2/, rows: (params) => [{ id: 'm1', session_id: 'ch-1', content: params[1] }] },
  ]);
  await reapStuckExternalJobs();
  const msg = db.calls.find((c) => /update messages set content = \$2/.test(c.n));
  assert.match(msg.params[1], /stopped responding/i);
});

test('finalizeAgentJobResult inserts a fresh message when there is no placeholder', async () => {
  const db = use([
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j', status: 'done' }] },
    { match: /^insert into messages/, rows: (params) => [{ id: 'm-new', session_id: params[0], content: params[1], sender_name: params[4] }] },
  ]);
  await finalizeAgentJobResult(
    // No responseMessageId in metadata → the insert branch (not the placeholder update).
    { id: 'j', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', agent_name: 'Coder', agent_handle: 'coder', metadata: JSON.stringify({ threadParentId: null, mode: 'external' }) },
    { responseText: 'fresh reply' },
  );
  const insert = db.calls.find((c) => /^insert into messages/.test(c.n));
  assert.ok(insert, 'must insert a new message when no placeholder exists');
  assert.equal(insert.params[1], 'fresh reply');
});

test('finalizeAgentJobResult formats an error reply when errorText is set', async () => {
  const db = use([
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j', status: 'error' }] },
    { match: /update messages set content = \$2/, rows: (params) => [{ id: 'm-1', session_id: 'ch-1', content: params[1] }] },
  ]);
  await finalizeAgentJobResult(
    { id: 'j', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', agent_name: 'Coder', agent_handle: 'coder', metadata: JSON.stringify({ responseMessageId: 'm-1' }) },
    { errorText: 'model timed out' },
  );
  const msg = db.calls.find((c) => /update messages set content = \$2/.test(c.n));
  assert.match(msg.params[1], /@coder failed: model timed out/);
});
