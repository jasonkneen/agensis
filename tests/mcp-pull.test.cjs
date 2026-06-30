const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const {
  verifyInviteToken,
  verifyMcpToken,
  runAgentTurn,
  claimMcpJob,
  submitMcpJobResult,
  reapStuckMcpJobs,
  finalizeAgentJobResult,
  resolveWorkspaceAgentByHandle,
  touchMcpPresence,
  hasMcpPresence,
  setTestDb,
  resetTestState,
} = __test;

const WS = 'ws-1';

// Fake pg: ordered { match, rows } handlers; first match wins, default []. Records calls.
function makeDb(handlers = []) {
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params });
      for (const h of handlers) {
        if (h.match.test(n)) return typeof h.rows === 'function' ? h.rows(params, n) : (h.rows || []);
      }
      return [];
    },
  };
  return db;
}
function use(handlers) { const db = makeDb(handlers); setTestDb(db); return db; }
test.afterEach(() => resetTestState());

// --- invite-token auth (the ONE link) --------------------------------------

test('verifyInviteToken resolves a valid invite to a workspace identity', async () => {
  use([{ match: /from workspace_invites where token = \$1 and status in/, rows: () => [{ id: 'inv-1', workspace_id: WS, email: 'cursor@x.com' }] }]);
  assert.deepEqual(await verifyInviteToken('tok'), { kind: 'invite', workspaceId: WS, inviteId: 'inv-1', name: 'cursor@x.com' });
});

test('verifyInviteToken returns null for missing/expired/revoked (no row)', async () => {
  use([{ match: /from workspace_invites/, rows: () => [] }]);
  assert.equal(await verifyInviteToken('nope'), null);
  assert.equal(await verifyInviteToken(''), null);
});

test('verifyMcpToken prefers an agent token, then falls back to an invite token', async () => {
  use([{ match: /from workspace_agents where connect_token_hash/, rows: () => [{ id: 'a1', workspace_id: WS, name: 'Coder', handle: 'coder', enabled: true }] }]);
  assert.equal((await verifyMcpToken('aga')).kind, 'agent');
  resetTestState();
  use([
    { match: /from workspace_agents where connect_token_hash/, rows: () => [] },
    { match: /from workspace_invites/, rows: () => [{ id: 'inv-1', workspace_id: WS, email: '' }] },
  ]);
  const i = await verifyMcpToken('invite');
  assert.equal(i.kind, 'invite');
  assert.equal(i.name, 'MCP client'); // empty email → default label
});

test('resolveWorkspaceAgentByHandle matches by handle (slugged)', async () => {
  use([{ match: /from workspace_agents where workspace_id = \$1 and enabled/, rows: () => [
    { id: 'a1', handle: 'q', name: 'Q' }, { id: 'a2', handle: 'coder', name: 'Coder' },
  ] }]);
  assert.equal((await resolveWorkspaceAgentByHandle(WS, 'coder')).id, 'a2');
  assert.equal((await resolveWorkspaceAgentByHandle(WS, 'q')).id, 'a1');
  assert.equal(await resolveWorkspaceAgentByHandle(WS, 'ghost'), null);
  assert.equal(await resolveWorkspaceAgentByHandle(WS, ''), null);
});

// --- presence + dispatch branch --------------------------------------------

function agent(extra = {}) {
  return { id: 'a1', workspace_id: WS, name: 'Q', handle: 'q', model: 'auto', run_mode: 'builtin', enabled: true, permission_mode: 'default', tools: '[]', skills: '[]', system_prompt: 'be helpful', ...extra };
}

test('runAgentTurn enqueues an MCP pull job when a client is working as the agent', async () => {
  touchMcpPresence('a1');
  assert.equal(hasMcpPresence('a1'), true);
  const db = use([
    { match: /^insert into messages/, rows: (p) => [{ id: 'm1', session_id: p[0], content: p[1] }] },
    { match: /^insert into agent_jobs/, rows: (p) => [{ id: 'job1', session_id: p[2], status: 'queued' }] },
  ]);
  const res = await runAgentTurn(agent(), { workspaceId: WS, sessionId: 'ch-1' });
  assert.deepEqual(res, { ok: true, pending: true });
  const job = db.calls.find((c) => /^insert into agent_jobs/.test(c.n));
  assert.match(job.params[5], /"mode":"mcp"/);
});

test('runAgentTurn (no MCP presence) does NOT enqueue an MCP job', async () => {
  // a fresh agent id never touched → no presence → falls through to builtin path.
  const db = use([
    { match: /^insert into agent_jobs/, rows: () => [{ id: 'jb', status: 'running' }] },
    { match: /^update agent_jobs/, rows: () => [{ id: 'jb', status: 'done' }] },
    { match: /^insert into messages/, rows: () => [{ id: 'm' }] },
  ]);
  const res = await runAgentTurn(agent({ id: 'a-fresh' }), { workspaceId: WS, sessionId: 'ch-1' });
  // builtin path runs (runAnthropicCompletion likely errors in test → ok:false), but no mcp job:
  assert.ok(!db.calls.some((c) => /^insert into agent_jobs/.test(c.n) && /"mode":"mcp"/.test(c.params[5] || '')));
});

// --- claimMcpJob ------------------------------------------------------------

test('claimMcpJob with no agent claims nothing', async () => {
  const db = use([]);
  assert.equal(await claimMcpJob({ workspaceId: WS, agentId: null }), null);
  assert.ok(!db.calls.some((c) => /update agent_jobs set status = 'running'/.test(c.n)));
});

test('claimMcpJob refreshes presence and atomically claims the oldest queued MCP job', async () => {
  const db = use([
    { match: /update agent_jobs set status = 'running'/, rows: () => [{ id: 'job1', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', prompt: 'do', metadata: JSON.stringify({ mode: 'mcp', threadParentId: null }) }] },
    { match: /select \* from workspace_agents where id = \$1/, rows: () => [{ id: 'a1', name: 'Q', handle: 'q', model: 'auto', workspace_id: WS }] },
  ]);
  const out = await claimMcpJob({ workspaceId: WS, agentId: 'a1' });
  assert.equal(out.jobId, 'job1');
  assert.equal(out.prompt, 'do');
  assert.equal(hasMcpPresence('a1'), true);
  const claim = db.calls.find((c) => /update agent_jobs set status = 'running'/.test(c.n));
  assert.ok(/for update skip locked/.test(claim.n));
  assert.ok(/agent_id = \$2/.test(claim.n));
});

test('claimMcpJob returns null when the queue is empty', async () => {
  use([{ match: /update agent_jobs set status = 'running'/, rows: () => [] }]);
  assert.equal(await claimMcpJob({ workspaceId: WS, agentId: 'a1' }), null);
});

// --- submitMcpJobResult -----------------------------------------------------

function lookup(job) { return { match: /select j\.\*, a\.name as agent_name/, rows: () => (job ? [job] : []) }; }

test('submitMcpJobResult rejects missing job / non-mcp / non-running', async () => {
  use([lookup(null)]);
  await assert.rejects(() => submitMcpJobResult({ workspaceId: WS, agentId: 'a1', jobId: 'x', responseText: 'y' }), /not found/i);
  resetTestState();
  use([lookup({ id: 'j', workspace_id: WS, agent_id: 'a1', status: 'running', metadata: JSON.stringify({ mode: 'daemon' }) })]);
  await assert.rejects(() => submitMcpJobResult({ workspaceId: WS, agentId: 'a1', jobId: 'j', responseText: 'y' }), /not an MCP job/i);
  resetTestState();
  use([lookup({ id: 'j', workspace_id: WS, agent_id: 'a1', status: 'done', metadata: JSON.stringify({ mode: 'mcp' }) })]);
  await assert.rejects(() => submitMcpJobResult({ workspaceId: WS, agentId: 'a1', jobId: 'j', responseText: 'y' }), /not awaiting a result/i);
});

test('submitMcpJobResult finalizes a running MCP job and rewrites the placeholder', async () => {
  const db = use([
    lookup({ id: 'j', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', status: 'running', agent_name: 'Q', agent_handle: 'q', metadata: JSON.stringify({ mode: 'mcp', responseMessageId: 'm1', threadParentId: null }) }),
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j', status: 'done' }] },
    { match: /update messages set content = \$2/, rows: (p) => [{ id: 'm1', session_id: 'ch-1', content: p[1] }] },
  ]);
  const out = await submitMcpJobResult({ workspaceId: WS, agentId: 'a1', jobId: 'j', responseText: 'the answer' });
  assert.deepEqual(out, { jobId: 'j', status: 'done' });
  assert.equal(db.calls.find((c) => /update messages set content = \$2/.test(c.n)).params[1], 'the answer');
});

// --- reaper + finalize edge -------------------------------------------------

test('reapStuckMcpJobs finalizes stale queued/running mcp jobs with an error', async () => {
  const db = use([
    { match: /where \(j\.metadata->>'mode'\) = 'mcp' and j\.status in/, rows: () => [{ id: 'j1', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', agent_name: 'Q', agent_handle: 'q', metadata: JSON.stringify({ responseMessageId: 'm1', mode: 'mcp' }) }] },
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j1', status: 'error' }] },
    { match: /update messages set content = \$2/, rows: (p) => [{ id: 'm1', content: p[1] }] },
  ]);
  await reapStuckMcpJobs();
  assert.match(db.calls.find((c) => /update messages set content = \$2/.test(c.n)).params[1], /stopped responding/i);
});

test('finalizeAgentJobResult inserts a fresh message when there is no placeholder', async () => {
  const db = use([
    { match: /update agent_jobs set status = \$2/, rows: () => [{ id: 'j', status: 'done' }] },
    { match: /^insert into messages/, rows: (p) => [{ id: 'm', session_id: p[0], content: p[1] }] },
  ]);
  await finalizeAgentJobResult({ id: 'j', workspace_id: WS, agent_id: 'a1', session_id: 'ch-1', agent_name: 'Q', agent_handle: 'q', metadata: JSON.stringify({ mode: 'mcp' }) }, { responseText: 'fresh' });
  assert.equal(db.calls.find((c) => /^insert into messages/.test(c.n)).params[1], 'fresh');
});
