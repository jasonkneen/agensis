'use strict';

// STATUS.md open item — streaming was "unverified end-to-end". The daemon half
// is covered by tests/daemonStreamParser.test.cjs. This covers the SERVER half:
// when the daemon posts an `agent_job_delta` for a job that has a chat
// placeholder (responseMessageId in metadata), handleAgentJobDelta must
//   1. update the agent_jobs.response,
//   2. update the placeholder MESSAGE row with the live content, and
//   3. fan the messages UPDATE out to subscribed realtime clients — which is
//      exactly what makes the browser render tokens as they stream in.
//
// notifyDbSubscribers has no test hook; it fans out through the websocket send
// path, so we assert the browser-visible behavior by registering a fake WS
// client subscribed to the session's messages and checking it received the
// db_changes UPDATE frame.

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

function makeDb(handlers = []) {
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ sql: normalized, params });
      const handler = handlers.find((item) => item.match.test(normalized));
      return handler ? (typeof handler.rows === 'function' ? handler.rows(params) : handler.rows) : [];
    },
    async begin(work) {
      return work(db);
    },
  };
  return db;
}

function fakeClient(userId, subscriptions) {
  const sent = [];
  return { userId, readyState: 1, subscriptions, sent, send: (str) => sent.push(JSON.parse(str)) };
}

test.afterEach(() => __test.resetTestState());

test('a delta with a chat placeholder streams live content into the message row', async () => {
  const db = makeDb([
    // job lookup — carries the responseMessageId placeholder in metadata
    {
      match: /select j\.\*, a\.name as agent_name/,
      rows: [{
        id: 'job-1', workspace_id: 'ws-1', agent_id: 'agent-1', session_id: 'session-1',
        agent_name: 'Coder', agent_handle: 'coder',
        metadata: JSON.stringify({ responseMessageId: 'msg-1' }),
      }],
    },
    { match: /update agent_jobs set response/, rows: [{ id: 'job-1' }] },
    {
      match: /update messages set content/,
      rows: (params) => [{
        id: 'msg-1', session_id: 'session-1', content: params[1],
        sender_kind: 'agent', sender_id: 'agent-1', sender_name: 'Coder',
        workspace_id: 'ws-1',
      }],
    },
    {
      match: /select id, visibility, folder, deleted_at from chat_sessions/,
      rows: [{ id: 'session-1', visibility: 'workspace', folder: 'General', deleted_at: null }],
    },
    {
      match: /select workspace_id, visibility, folder, deleted_at from chat_sessions/,
      rows: [{ workspace_id: 'ws-1', visibility: 'workspace', folder: 'General', deleted_at: null }],
    },
    {
      match: /select id, visibility, folder from chat_sessions/,
      rows: [{ id: 'session-1', visibility: 'workspace', folder: 'General' }],
    },
  ]);
  __test.setTestDb(db);

  // A browser client subscribed to this session's messages.
  const client = __test.registerTestWebsocketClient(fakeClient('user-1', [{
    channel: 'messages:session-1',
    type: 'db_changes',
    table: 'messages',
    filter: 'session_id=eq.session-1',
  }]));

  await __test.handleAgentJobDelta(
    { agentAuth: { workspaceId: 'ws-1', agentId: 'agent-1', name: 'Coder' }, agentConnectionId: 'connection-1' },
    { jobId: 'job-1', content: 'Hello, streaming world', elapsedMs: 800 },
  );
  await new Promise(resolve => setTimeout(resolve, 20));

  // 1. job response updated
  assert.equal(db.calls.some((c) => /update agent_jobs set response/.test(c.sql)), true);
  // 2. message row updated with the live content
  const msgUpdate = db.calls.find((c) => /update messages set content/.test(c.sql));
  assert.ok(msgUpdate, 'expected a messages UPDATE');
  assert.equal(msgUpdate.params[1], 'Hello, streaming world');
  // 3. the browser-subscribed client received the db_changes UPDATE frame
  const frame = client.sent.find((m) => m.type === 'db_changes' && m.table === 'messages');
  assert.ok(frame, 'expected a db_changes messages frame to reach the subscriber');
  assert.equal(frame.payload.eventType, 'UPDATE');
  assert.equal(frame.payload.new.content, 'Hello, streaming world');
});

test('a delta for a placeholder-less (Farm) job updates the job but sends no message frame', async () => {
  const db = makeDb([
    {
      match: /select j\.\*, a\.name as agent_name/,
      rows: [{ id: 'job-1', workspace_id: 'ws-1', agent_id: 'agent-1', session_id: null, metadata: JSON.stringify({ mode: 'farm' }) }],
    },
    { match: /update agent_jobs set response/, rows: [{ id: 'job-1' }] },
  ]);
  __test.setTestDb(db);

  const client = __test.registerTestWebsocketClient(fakeClient('user-1', [{
    channel: 'messages:session-1', type: 'db_changes', table: 'messages', filter: 'session_id=eq.session-1',
  }]));

  await __test.handleAgentJobDelta(
    { agentAuth: { workspaceId: 'ws-1', agentId: 'agent-1', name: 'Coder' }, agentConnectionId: 'connection-1' },
    { jobId: 'job-1', content: 'working', elapsedMs: 500 },
  );

  assert.equal(db.calls.some((c) => /update agent_jobs set response/.test(c.sql)), true);
  assert.equal(db.calls.some((c) => /update messages set content/.test(c.sql)), false);
  assert.equal(client.sent.some((m) => m.type === 'db_changes' && m.table === 'messages'), false);
});
