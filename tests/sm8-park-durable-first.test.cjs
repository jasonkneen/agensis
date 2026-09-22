'use strict';

// A failed durable shadow must not destroy the live wake-up it protects.
// Exercise rejection timing and recovery, rather than pinning rollback syntax.
const test = require('node:test');
const assert = require('node:assert/strict');
const { __test: api } = require('../server/index.cjs');
const target = {
 workspaceId: '33333333-3333-4333-8333-333333333333',
 sessionId: '11111111-1111-4111-8111-111111111111',
 agentId: '22222222-2222-4222-8222-222222222222',
 targetAgentId: '22222222-2222-4222-8222-222222222222',
 threadParentId: null, broadcastToChannel: null,
};
const key = `${target.sessionId}::${target.agentId}`;
const settle = () => new Promise(resolve => setImmediate(resolve));
test.afterEach(() => api.resetTestState());

test('a rejected durable write retains the wake without dispatching', async () => {
 api.setTestDb({ unsafe: async () => { throw new Error('database unavailable'); } });
 api.parkChatTurn(target);
 assert.equal(api.pendingChatTurns.size, 1);
 await settle();
 assert.equal(api.pendingChatTurns.size, 1);
 let replayed = 0;
 await api.drainPendingChatTurn(target.sessionId, target.agentId, 'test', async () => {
  replayed++;
  return { started: true };
 });
 assert.equal(replayed, 0);
 assert.equal(api.pendingChatTurns.size, 1);
});

test('a late failed write cannot erase a newer parked message', async () => {
 let rejectFirst;
 let writes = 0;
 api.setTestDb({ unsafe: () => ++writes === 1
  ? new Promise((_resolve, reject) => { rejectFirst = reject; })
  : Promise.resolve([]) });
 api.parkChatTurn(target);
 api.parkChatTurn({ ...target, threadParentId: 'new-thread' });
 rejectFirst(new Error('late failure'));
 await settle();
 assert.equal(api.pendingChatTurns.get(key).threadParentId, 'new-thread');
});

test('the sweep retries failed persistence even while the agent remains busy', async () => {
 let unavailable = true;
 const writes = [];
 api.setTestDb({ unsafe: async (sql, params) => {
  if (unavailable) throw new Error('offline');
  writes.push({ sql, params });
  return [];
 } });
 api.parkChatTurn(target);
 await settle();
 unavailable = false;
 await api.replayOrphanedChatTurns({ isAgentBusy: async () => true });
 assert.equal(writes.length, 1);
 assert.match(writes[0].sql, /insert into pending_chat_turns/);
 assert.equal(writes[0].params[0], key);
 assert.equal(api.pendingChatTurns.size, 1);
 await api.replayOrphanedChatTurns({ isAgentBusy: async () => true });
 assert.equal(writes.length, 1, 'successful persistence is not repeated each sweep');
});

test('failed re-parking retains the attempt cap and original age', async () => {
 api.setTestDb({ unsafe: async () => { throw new Error('offline'); } });
 api.parkChatTurn(target);
 const parkedAt = api.pendingChatTurns.get(key).parkedAt;
 await api.drainPendingChatTurn(target.sessionId, target.agentId, 'test', async () => ({ started: false, reason: 'agent_busy' }));
 await settle();
 assert.equal(api.pendingChatTurns.get(key).attempts, 1);
 assert.equal(api.pendingChatTurns.get(key).parkedAt, parkedAt);
});

test('draining persists attempts before dispatch and deletes only after dispatch', async () => {
 let finishInsert;
 let first = true;
 const events = [];
 api.setTestDb({ unsafe: (sql) => {
  if (/insert/.test(sql)) {
   if (first) { first = false; return new Promise(resolve => {
    finishInsert = () => { events.push('insert'); resolve([]); };
   }); }
   events.push('attempt'); return Promise.resolve([]);
  }
  events.push('delete'); return Promise.resolve([]);
 } });
 api.parkChatTurn(target);
 const drain = api.drainPendingChatTurn(target.sessionId, target.agentId, 'test', async () => {
  events.push('dispatch'); return { started: true };
 });
 assert.deepEqual(events, []);
 finishInsert();
 await drain;
 await settle();
 assert.deepEqual(events, ['insert', 'attempt', 'dispatch', 'delete']);
});
