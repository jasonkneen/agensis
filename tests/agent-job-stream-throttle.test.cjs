'use strict';

// Streaming deltas used to UPDATE agent_jobs.response and messages.content with
// the full accumulated text on every frame. Persisted writes are now throttled
// (leading write, then at most one per interval, always flushed before a result),
// while realtime fan-out keeps its per-delta cadence.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

function makeDb() {
  const db = {
    calls: [],
    jobResponse: '',
    messageContent: '',
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params });
      if (/select j\.\*, a\.name as agent_name/.test(n)) {
        return [{
          id: 'job-1', workspace_id: 'ws-1', agent_id: 'agent-1', session_id: 'session-1',
          agent_name: 'Coder', agent_handle: 'coder', response: db.jobResponse,
          metadata: { responseMessageId: 'msg-1' },
        }];
      }
      if (n.startsWith('update agent_jobs set response = case')) {
        if (params[1]) db.jobResponse = params[1];
        return [{ id: 'job-1' }];
      }
      if (n.startsWith('update agent_jobs set response = $2')) {
        db.jobResponse = params[1];
        return [{ id: 'job-1' }];
      }
      if (n.startsWith('update messages set content')) {
        db.messageContent = params[1];
        return [{ id: 'msg-1', session_id: 'session-1', content: params[1] }];
      }
      return [];
    },
    async begin(work) { return work(db); },
  };
  return db;
}

const ws = () => ({ agentAuth: { workspaceId: 'ws-1', agentId: 'agent-1', name: 'Coder' }, agentConnectionId: 'conn-1' });

test('200 rapid deltas cause at most 8 update statements and the final text is exact', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const socket = ws();
  let text = '';
  for (let i = 0; i < 200; i += 1) {
    text += `w${i} `;
    await __test.handleAgentJobDelta(socket, { jobId: 'job-1', content: text, elapsedMs: i * 10 });
  }
  const updates = () => db.calls.filter((c) => c.n.startsWith('update '));
  assert.ok(updates().length <= 8, `expected <= 8 updates, got ${updates().length}`);
  assert.ok(db.messageContent.length > 0, 'the leading delta wrote immediately');

  // Any terminal path flushes the pending text first, so a bodyless result still sees the latest.
  await __test.finalizeStuckJob({ id: 'job-1', session_id: 'session-1', metadata: { responseMessageId: 'msg-1' } }, 'x');
  assert.equal(db.jobResponse.trim(), text.trim(), 'flush persisted the latest accumulated text');
  assert.equal(db.messageContent.trim(), text.trim());
});
