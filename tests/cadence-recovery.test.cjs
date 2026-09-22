'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTaskDispatch } = require('../server/task-dispatch.cjs');
const target = { workspaceId: 'workspace', sessionId: 'session', threadParentId: null };
const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
function fixture(t, unsafe) {
 const calls = [];
 const dispatch = createTaskDispatch({ getDb: () => ({ unsafe }), continueConversation: async args => { calls.push(args); } });
 t.after(() => dispatch.reset());
 return { dispatch, calls };
}
test('a durable timer does not dispatch a row another replica claimed', async t => {
 const { dispatch, calls } = fixture(t, async () => []);
 dispatch.scheduleCadenceWake('session::', 1, target);
 await wait();
 assert.equal(calls.length, 0);
 assert.equal(dispatch.cadenceWakes.size, 0);
});
test('a durable timer dispatches only after winning its claim', async t => {
 const { dispatch, calls } = fixture(t, async sql => /with due/.test(sql) ? [{ lock_key: 'session::', workspace_id: 'workspace', session_id: 'session', thread_parent_id: null, wake_id: 'wake', claim_token: 'claim' }] : []);
 dispatch.scheduleCadenceWake('session::', 1, target);
 await wait();
 assert.deepEqual(calls, [{ ...target, targetAgentId: null, dispatchWakeId: 'wake' }]);
});
test('a synchronous persistence failure defers the live wake until recovery', async t => {
 const { dispatch, calls } = fixture(t, () => { throw new Error('database unavailable'); });
 assert.doesNotThrow(() => dispatch.scheduleCadenceWake('session::', 1, target));
 await wait();
 assert.deepEqual(calls, []);
});
test('failed durable claims leave recovery to the sweep rather than dispatching twice', async t => {
 const { dispatch, calls } = fixture(t, async sql => {
  if (/with due/.test(sql)) throw new Error('connection lost during claim');
  return [];
 });
 dispatch.scheduleCadenceWake('session::', 1, target);
 await wait();
 assert.equal(calls.length, 0);
});
test('the reaper claims a bounded batch and dispatches its own locally scheduled row', async t => {
 let query;
 let params;
 const { dispatch, calls } = fixture(t, async (sql, bindings) => {
  if (!/with due/.test(sql)) return [];
  query = sql; params = bindings;
  return [{ lock_key: 'session::', workspace_id: 'workspace', session_id: 'session', agent_id: 'agent', thread_parent_id: 'thread', wake_id: 'wake', claim_token: 'claim' }];
 });
 dispatch.scheduleCadenceWake('session::', 60_000, target);
 assert.equal(await dispatch.reapCadenceWakes({ now: 1234, maxBatch: 5 }), 1);
 assert.match(query, /limit \$2 for update skip locked/);
 assert.deepEqual(params, [1234, 5, null]);
 assert.deepEqual(calls, [{ workspaceId: 'workspace', sessionId: 'session', targetAgentId: 'agent', threadParentId: 'thread', dispatchWakeId: 'wake' }]);
 assert.equal(dispatch.cadenceWakes.size, 0);
});
test('cancellation waits for insertion and prevents a waiting timer from firing', async t => {
 let inserted;
 const queries = [];
 const { dispatch, calls } = fixture(t, (sql) => {
  queries.push(sql);
  if (/insert/.test(sql)) return new Promise(resolve => { inserted = resolve; });
  return Promise.resolve([{ lock_key: 'session::' }]);
 });
 dispatch.scheduleCadenceWake('session::', 1, target);
 await wait(5);
 dispatch.clearCadenceWakes();
 assert.equal(queries.length, 1);
 inserted([]);
 await wait();
 assert.equal(queries.length, 2);
 assert.match(queries[1], /delete from pending_cadence_wakes/);
 assert.equal(calls.length, 0);
});

test('dispatch failure releases the lease while preserving the same durable wake', async () => {
 const { createCadenceWakes } = require('../server/cadence-wakes.cjs');
 let row = { lock_key: 's::', wake_id: 'stable-wake', workspace_id: 'w', session_id: 's', attempts: 0 };
 let fail = true;
 const ids = [], mutations = [];
 const wakes = createCadenceWakes({
  getDb: () => ({ unsafe: async (sql, args) => {
   if (/with due/.test(sql)) {
    if (!row || row.claim_token) return [];
    row.claim_token = `lease-${++row.attempts}`; return [{ ...row }];
   }
   if (/set claim_token = null/.test(sql)) {
    assert.equal(args[1], row.claim_token);
    mutations.push('retain'); row.claim_token = null; return [];
   }
   if (/delete from/.test(sql)) {
    assert.equal(args[1], row.claim_token);
    mutations.push('delete'); row = null;
   }
   return [];
  } }),
  continueConversation: async args => { ids.push(args.dispatchWakeId); if (fail === true) throw new Error('handoff failed'); if (fail === 'busy') return { started: false, reason: 'agent_busy' }; return { started: true }; },
 });
 await wakes.reapCadenceWakes();
 assert.ok(row);
 assert.deepEqual(mutations, ['retain']);
 fail = 'busy';
 await wakes.reapCadenceWakes();
 assert.ok(row, 'busy is a deferred handoff, not completion');
 fail = false;
 await wakes.reapCadenceWakes();
 assert.equal(row, null);
 assert.deepEqual(ids, ['stable-wake', 'stable-wake', 'stable-wake']);
 assert.deepEqual(mutations, ['retain', 'retain', 'delete']);
});
