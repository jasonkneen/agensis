'use strict';

// A dispatched child job that ends badly must tell its dispatcher exactly once.
// The idempotence lives in the INSERT itself (insert ... where not exists), so
// the fake db here applies that same prefix rule and the test also pins the
// SQL shape — a fake alone could only test itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAgentJobs } = require('../server/agent-jobs.cjs');

function fixture() {
  const messages = [];
  const published = [];
  const db = {
    statements: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.statements.push(n);
      if (n.startsWith('insert into messages')) {
        const [sessionId, content, prefix] = params;
        if (messages.some((m) => m.session_id === sessionId && m.content.startsWith(prefix))) return [];
        const row = { id: `m${messages.length}`, session_id: sessionId, content, sender_kind: 'system' };
        messages.push(row);
        return [row];
      }
      return [];
    },
    async begin(work) { return work(db); },
  };
  const jobs = createAgentJobs({
    getDb: () => db, parseJsonObject: (x) => (typeof x === 'string' ? JSON.parse(x) : x || {}),
    notifyDbSubscribers: (...args) => published.push(args), scheduleTaskQueueDrain() {}, drainPendingChatTurn() {},
  });
  return { db, jobs, messages, published };
}

const child = (extra = {}) => ({
  id: 'job-9', agent_handle: 'scout', error: 'boom',
  metadata: { dispatchedBy: { agentId: 'parent', sessionId: 'parent-session', jobId: 'job-1' }, ...extra },
});

test('a failed child posts one [child-failure:<id>] message into the dispatcher session', async () => {
  const { jobs, messages, published } = fixture();
  await jobs.notifyDispatcherOfFailure(child(), { status: 'error', reason: 'it crashed' });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].session_id, 'parent-session');
  assert.ok(messages[0].content.startsWith('[child-failure:job-9]'));
  assert.equal(published.length, 1);
});

test('replays never duplicate it', async () => {
  const { jobs, messages, db } = fixture();
  for (let i = 0; i < 3; i += 1) await jobs.notifyDispatcherOfFailure(child(), { status: 'error', reason: 'x' });
  assert.equal(messages.length, 1);
  assert.match(db.statements[0], /where not exists \( select 1 from messages/);
});

test('jobs without dispatchedBy, or that completed, notify nobody', async () => {
  const { jobs, messages } = fixture();
  await jobs.notifyDispatcherOfFailure({ id: 'j', metadata: {} }, { status: 'error' });
  await jobs.notifyDispatcherOfFailure(child(), { status: 'done' });
  assert.equal(messages.length, 0);
});

test('a reaped child notifies its dispatcher through finalizeStuckJob', async () => {
  const { jobs, messages, db } = fixture();
  const base = db.unsafe;
  db.unsafe = async (sql, params) => (/^\s*update agent_jobs set status/i.test(sql) ? [{ id: 'job-9' }] : base(sql, params));
  await jobs.finalizeStuckJob({ ...child(), workspace_id: 'w', session_id: 's', agent_id: 'a' }, 'timed out', 'idle_timeout');
  assert.equal(messages.length, 1);
  assert.ok(messages[0].content.startsWith('[child-failure:job-9]'));
});
