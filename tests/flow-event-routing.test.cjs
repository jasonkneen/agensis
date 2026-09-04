'use strict';

// Flow and automation enqueueing must re-check the source session's current
// privacy marker. These tests use the exported index seams with a fake DB so a
// private conversation never enters the durable outbound queue.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

const SESSION = '00000000-0000-4000-8000-000000000001';
const WORKSPACE = '00000000-0000-4000-8000-000000000002';

function installDb(session) {
 const queries = [];
 const db = {
  queries,
  async unsafe(sql, params = []) {
   const query = String(sql).replace(/\s+/g, ' ').trim();
   queries.push({ query, params });
   if (query.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')) {
    return session ? [{ id: SESSION, workspace_id: WORKSPACE, ...session }] : [];
   }
   if (query.startsWith('select id, workspace_id, channel_id, events from flow_connections')) {
    return [{ id: 'flow-1', workspace_id: WORKSPACE, channel_id: null, events: ['message.created'] }];
   }
   if (query.startsWith('insert into flow_webhook_deliveries')) return [];
   return [];
  },
 };
 __test.setTestDb(db);
 return db;
}

test.afterEach(() => __test.resetTestState());

test('private message sessions are ineligible for Flow enqueueing', async () => {
 const db = installDb({ visibility: 'private', folder: 'Direct messages', deleted_at: null });
 const row = { id: '00000000-0000-4000-8000-000000000003', session_id: SESSION, content: 'secret' };
 assert.equal(await __test.flowEventLocation('messages', row), null);
 await __test.enqueueFlowWebhookEvents('messages', 'INSERT', [row]);
 assert.equal(db.queries.some(({ query }) => query.startsWith('insert into flow_webhook_deliveries')), false);
});

test('notifyDbSubscribers re-resolves partial private message and session rows before Flow enqueueing', async () => {
 const db = installDb({ visibility: 'private', folder: 'Direct messages', deleted_at: null });
 const message = { id: '00000000-0000-4000-8000-000000000003', session_id: SESSION, content: 'secret' };
 const partialSession = { id: SESSION, workspace_id: WORKSPACE, title: 'private title' };
 await __test.notifyDbSubscribers('messages', 'INSERT', [message]);
 await __test.notifyDbSubscribers('chat_sessions', 'UPDATE', [partialSession]);
 // notifyDbSubscribers intentionally does not await the optional queue lanes.
 await new Promise((resolve) => setTimeout(resolve, 25));
 assert.equal(db.queries.some(({ query }) => query.startsWith('insert into flow_webhook_deliveries')), false);
});

test('public Flow events remain eligible and are rejected after a privacy transition', async () => {
 const db = installDb({ visibility: 'workspace', folder: 'Channels', deleted_at: null });
 const row = { id: '00000000-0000-4000-8000-000000000003', session_id: SESSION, content: 'public' };
 assert.deepEqual(await __test.flowEventLocation('messages', row), { workspaceId: WORKSPACE, channelId: SESSION });
 const delivery = {
  event_type: 'message.created',
  workspace_id: WORKSPACE,
  payload: { channelId: SESSION },
 };
 assert.equal(await __test.flowDeliverySourceIsEligible(delivery), true);

 // The same resolver sees the current DB row. A subsequent transition to a DM
 // therefore blocks a queued delivery even though it was public on enqueue.
 db.unsafe = async (sql, params = []) => {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  if (query.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')) {
   return [{ id: SESSION, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages', deleted_at: null }];
  }
  return [];
 };
 assert.equal(await __test.flowDeliverySourceIsEligible(delivery), false);
});

test('queued private transition is dead-lettered without an outbound fetch', async () => {
 const db = installDb({ visibility: 'private', folder: 'Direct messages', deleted_at: null });
 db.unsafe = async (sql, params = []) => {
  const query = String(sql).replace(/\s+/g, ' ').trim();
  db.queries.push({ query, params });
  if (query.startsWith('with candidate as')) {
   return [{
    id: 'delivery-1',
    claim_token: 'claim-1',
    attempt_count: 1,
    workspace_id: WORKSPACE,
    event_type: 'message.created',
    payload: { channelId: SESSION, data: { content: 'private now' } },
    webhook_url: 'https://example.test/hook',
    signing_secret_cipher: 'cipher',
    event_id: 'message.created:event-1',
   }];
  }
  if (query.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')) {
   return [{ id: SESSION, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages', deleted_at: null }];
  }
  return [];
 };
 let fetchCalls = 0;
 const originalFetch = global.fetch;
 global.fetch = async () => { fetchCalls += 1; throw new Error('outbound fetch must not run'); };
 try {
  assert.equal(await __test.deliverNextFlowWebhook(), true);
 } finally {
  global.fetch = originalFetch;
 }
 assert.equal(fetchCalls, 0);
 const scrub = db.queries.find(({ query }) => query.startsWith('update flow_webhook_deliveries'));
 assert.ok(scrub);
 assert.match(scrub.query, /status = 'dead'/);
 assert.match(scrub.query, /payload = '\{\}'::jsonb/);
});
