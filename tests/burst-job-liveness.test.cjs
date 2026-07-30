// ============================================================================
// tests/burst-job-liveness.test.cjs
// ----------------------------------------------------------------------------
// Wedged-DM regression (2026-07): a queued/running agent_job whose worker is
// gone (daemon socket closed / connection row pruned to NULL, or an MCP client
// that left) used to block hasActiveBurstJob forever — every new turn in that
// session was silently dropped, so a healthy reconnected agent could not speak
// in its own DM. Two guarantees are locked in here:
//   1. finalizeStuckJob writes status='error' (a value the agent_jobs status
//      CHECK constraint actually permits) — NOT 'failed', which threw a
//      constraint violation that the best-effort try/catch swallowed, leaving
//      the job 'running' forever.
//   2. hasActiveBurstJob treats a phantom job as non-blocking AND finalizes it,
//      while a live worker (MCP presence) still blocks to prevent duplicate turns.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

test('finalizeStuckJob writes status=error (constraint-valid), never failed', async () => {
  const updates = [];
  __test.setTestDb({
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('update agent_jobs set status')) {
        updates.push({ n, params });
        return [{ id: 'job-1' }]; // pretend the row was 'running' and got finalized
      }
      // finalizeStuckJob then tries to rewrite the placeholder message; no
      // responseMessageId in metadata here, so it returns before reaching it.
      return [];
    },
  });

  await __test.finalizeStuckJob({ id: 'job-1', session_id: 's1', metadata: {} }, 'timed out');
  assert.equal(updates.length, 1, 'the job status was updated exactly once');
  assert.match(updates[0].n, /status = 'error'/, "finalized as 'error'");
  assert.doesNotMatch(updates[0].n, /'failed'/, "must not write the constraint-invalid 'failed'");
});

test('hasActiveBurstJob: a daemon job with a null connection is a phantom → not blocking, and gets finalized', async () => {
  const finalized = [];
  __test.setTestDb({
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs')) {
        return [{ id: 'phantom-1', status: 'running', connection_id: null, metadata: { mode: 'daemon' }, started_at: new Date() }];
      }
      if (n.startsWith('update agent_jobs set status')) {
        finalized.push(params[0]);
        return [{ id: params[0] }];
      }
      return [];
    },
  });

  const blocking = await __test.hasActiveBurstJob('s1', 'agent-1');
  assert.equal(blocking, false, 'a phantom daemon job must not wedge the session');
  assert.deepEqual(finalized, ['phantom-1'], 'the phantom job was finalized so it stops blocking future turns too');
});

test('hasActiveBurstJob: a queued MCP job with NO client presence is a phantom → not blocking', async () => {
  __test.setTestDb({
    async unsafe(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs')) {
        return [{ id: 'mcp-1', status: 'queued', connection_id: null, metadata: { mode: 'mcp' }, started_at: null }];
      }
      return []; // finalize path best-effort
    },
  });

  // No touchMcpPresence('agent-1') → hasMcpPresence is false → phantom.
  const blocking = await __test.hasActiveBurstJob('s1', 'agent-1');
  assert.equal(blocking, false, 'a queued MCP job nobody can claim must not wedge the session');
});

test('hasActiveBurstJob: a RUNNING MCP job with lapsed presence still blocks (never kill a live turn)', async () => {
  __test.setTestDb({
    async unsafe(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs')) {
        // Claimed and being worked on; presence (40s TTL) has lapsed because the
        // client is busy executing, not polling. It must NOT be treated as phantom.
        return [{ id: 'mcp-run', status: 'running', connection_id: null, metadata: { mode: 'mcp' }, started_at: new Date() }];
      }
      throw new Error(`must not finalize a live running MCP job; unexpected SQL: ${n}`);
    },
  });

  // Deliberately NO touchMcpPresence — presence is lapsed, mid-turn.
  const blocking = await __test.hasActiveBurstJob('s1', 'agent-1');
  assert.equal(blocking, true, 'a running MCP turn must stay live (240s reaper is the backstop), not be killed');
});

test('hasActiveBurstJob: a queued MCP job WITH a live client present still blocks (no duplicate turn)', async () => {
  __test.setTestDb({
    async unsafe(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id, status, connection_id, metadata, started_at from agent_jobs')) {
        return [{ id: 'mcp-2', status: 'queued', connection_id: null, metadata: { mode: 'mcp' }, started_at: null }];
      }
      throw new Error(`must not finalize a live job; unexpected SQL: ${n}`);
    },
  });

  __test.touchMcpPresence('agent-1'); // a polling client is present and will claim it
  const blocking = await __test.hasActiveBurstJob('s1', 'agent-1');
  assert.equal(blocking, true, 'a live MCP job must still block to prevent a duplicate turn');
});
