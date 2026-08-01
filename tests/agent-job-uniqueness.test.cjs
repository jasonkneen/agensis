// ============================================================================
// tests/agent-job-uniqueness.test.cjs
// ----------------------------------------------------------------------------
// M15 (2026-07 review): a partial unique index enforces one ACTIVE (queued/
// running) agent_job per (session, agent) so concurrent triggers can't produce
// duplicate turns across Fly instances. insertActiveAgentJob tolerates the
// resulting unique violation (SQLSTATE 23505): it cleans up the "Thinking"
// placeholder message and returns null so the caller stops the drain loop.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

const RESERVATION = {
  workspaceId: 'ws', agentId: 'agent', sessionId: 'session', requireMcpApproval: false,
};

test('M15: a normal insert returns the job rows', async () => {
  const calls = [];
  const db = {
    async begin(callback) { return callback(db); },
    async unsafe(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      if (String(sql).includes('from chat_sessions s')) return [{ id: 'session' }];
      return [{ id: 'job-1', status: 'queued' }];
    },
  };
  __test.setTestDb(db);

  const rows = await __test.insertActiveAgentJob(
    'insert into agent_jobs (...) values (...) returning *',
    ['ws', 'agent'],
    'placeholder-1',
    RESERVATION,
  );
  assert.deepEqual(rows, [{ id: 'job-1', status: 'queued' }]);
  const proof = calls.find((call) => call.sql.startsWith('select s.id from chat_sessions'));
  assert.match(proof.sql, /s\.deleted_at is null/);
  assert.match(proof.sql, /a\.enabled is true/);
  assert.match(proof.sql, /a\.mcp_approved is true/);
  assert.match(proof.sql, /jsonb_array_elements/);
  assert.match(proof.sql, /for share of s, a/);
  // Success path must not delete the placeholder.
  assert.ok(!calls.some(c => c.sql.startsWith('delete from messages')), 'placeholder is kept on success');
});

test('M15: a unique violation returns null and deletes the placeholder', async () => {
  const deletes = [];
  const db = {
    async begin(callback) { return callback(db); },
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select s.id from chat_sessions')) return [{ id: 'session' }];
      if (n.startsWith('insert into agent_jobs')) {
        const err = new Error('duplicate key value violates unique constraint "uq_agent_jobs_active_per_session_agent"');
        err.code = '23505';
        throw err;
      }
      if (n.startsWith('delete from messages')) {
        deletes.push(params[0]);
        return [{ id: params[0] }];
      }
      throw new Error(`Unexpected SQL: ${n}`);
    },
  };
  __test.setTestDb(db);

  const rows = await __test.insertActiveAgentJob(
    'insert into agent_jobs (...) values (...) returning *',
    ['ws', 'agent'],
    'placeholder-1',
    RESERVATION,
  );
  assert.equal(rows, null, 'a concurrent turn won the race → null');
  assert.deepEqual(deletes, ['placeholder-1'], 'the orphaned Thinking placeholder was cleaned up');
});

test('M15: a non-unique DB error still propagates (not swallowed)', async () => {
  const db = {
    async begin(callback) { return callback(db); },
    async unsafe(sql) {
      if (String(sql).includes('from chat_sessions s')) return [{ id: 'session' }];
      const err = new Error('some other db failure');
      err.code = '42P01'; // undefined_table — a real error we must not hide
      throw err;
    },
  };
  __test.setTestDb(db);

  await assert.rejects(
    () => __test.insertActiveAgentJob(
      'insert into agent_jobs (...) values (...) returning *',
      [],
      null,
      RESERVATION,
    ),
    /some other db failure/,
  );
});
