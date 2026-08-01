'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { mountAuthRoutes } = require('../server/auth-routes.cjs');
const {
  ADVANCE_READ_MARKER_SQL,
  DELETE_HUMAN_READ_MARKERS_SQL,
} = require('../shared/read-receipts.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AGENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MESSAGE_A = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const MESSAGE_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const THREAD_ROOT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

const HUMAN_MARKERS = [
  {
    marker_id: '10000000-0000-4000-8000-000000000001', event_version: '11',
    session_id: SESSION_A, user_id: USER, agent_id: null, thread_parent_id: null,
    last_seen_message_id: MESSAGE_A, read_at: '2026-07-31T10:00:00.000Z',
  },
  {
    marker_id: '10000000-0000-4000-8000-000000000002', event_version: '12',
    session_id: SESSION_B, user_id: USER, agent_id: null, thread_parent_id: THREAD_ROOT,
    last_seen_message_id: MESSAGE_B, read_at: '2026-07-31T11:00:00.000Z',
  },
];

function profile(receipts) {
  return {
    id: USER,
    email: 'reader@example.test',
    display_name: 'Reader',
    accent_color: '#123456',
    share_read_receipts: receipts,
    created_at: '2026-07-31T00:00:00.000Z',
  };
}

async function createHarness() {
  let sharing = true;
  let humanMarkers = HUMAN_MARKERS.map(marker => ({ ...marker }));
  const agentMarkers = [
    {
      marker_id: '10000000-0000-4000-8000-000000000003', event_version: '13',
      session_id: SESSION_A, user_id: null, agent_id: AGENT, thread_parent_id: null,
      last_seen_message_id: MESSAGE_A, read_at: '2026-07-31T12:00:00.000Z',
    },
  ];
  const transactions = [];
  const notifications = [];
  const revoked = [];

  const execute = async (sql, params = []) => {
    const normalized = String(sql).replace(/\s+/g, ' ').trim();
    const q = normalized.toLowerCase();
    if (q.startsWith('update app_users set')) {
      sharing = Boolean(params[1]);
      transactions.push({ kind: 'profile', sql: normalized, params });
      return [profile(sharing)];
    }
    if (q.startsWith('delete from session_read_state')) {
      transactions.push({ kind: 'delete', sql: normalized, params });
      const removed = humanMarkers;
      humanMarkers = [];
      return removed;
    }
    throw new Error(`Unexpected opt-out query: ${normalized}`);
  };
  const db = {
    unsafe: execute,
    async begin(callback) {
      transactions.push({ kind: 'begin' });
      const result = await callback({ unsafe: execute });
      transactions.push({ kind: 'commit' });
      return result;
    },
  };

  const app = express();
  app.use(express.json());
  mountAuthRoutes(app, {
    requireAuth(req, _res, next) {
      req.userId = USER;
      next();
    },
    jsonError(res, status, error) {
      res.status(status).json({ data: null, error: { message: error.message } });
    },
    getDb: () => db,
    notifyDbSubscribers(table, eventType, rows) {
      notifications.push({ table, eventType, rows });
    },
    async revokeRealtimeAccessForMember(userId, options) {
      revoked.push({ userId, options });
    },
  });

  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())),
    state: {
      transactions,
      notifications,
      revoked,
      humanMarkers: () => humanMarkers,
      agentMarkers: () => agentMarkers,
      sharing: () => sharing,
    },
  };
}

async function patchReceipts(baseUrl, enabled) {
  return fetch(`${baseUrl}/backend/users/me`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ share_read_receipts: enabled }),
  });
}

test('opt-out commits the setting and human-marker deletion before realtime invalidation', async () => {
  const harness = await createHarness();
  try {
    const response = await patchReceipts(harness.baseUrl, false);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).data.share_read_receipts, false);

    assert.deepEqual(
      harness.state.transactions.map(step => step.kind),
      ['begin', 'profile', 'delete', 'commit'],
    );
    assert.equal(harness.state.sharing(), false);
    assert.deepEqual(harness.state.humanMarkers(), []);
    assert.equal(harness.state.agentMarkers().length, 1, 'agent policy is independent');
    assert.deepEqual(harness.state.revoked, [{
      userId: USER,
      options: { reason: 'read_receipts_disabled' },
    }]);
    assert.deepEqual(harness.state.notifications, [{
      table: 'session_read_state',
      eventType: 'DELETE',
      rows: HUMAN_MARKERS,
    }]);
  } finally {
    await harness.close();
  }
});

test('re-enable starts empty until a new read advances the marker', async () => {
  const harness = await createHarness();
  try {
    assert.equal((await patchReceipts(harness.baseUrl, false)).status, 200);
    harness.state.notifications.length = 0;
    harness.state.revoked.length = 0;

    const response = await patchReceipts(harness.baseUrl, true);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).data.share_read_receipts, true);
    assert.deepEqual(harness.state.humanMarkers(), []);
    assert.deepEqual(harness.state.notifications, []);
    assert.deepEqual(harness.state.revoked, []);
  } finally {
    await harness.close();
  }
});

test('the marker writer and opt-out transaction take compatible account-row locks', () => {
  assert.match(
    ADVANCE_READ_MARKER_SQL,
    /receipt_sharing_user[\s\S]*for share of sharing_user/,
  );
  assert.match(DELETE_HUMAN_READ_MARKERS_SQL, /agent_id is null/);
});

test('the Netlify mirror forwards deployed privacy changes and keeps a local atomic fallback', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../netlify/functions/backend.mjs'),
    'utf8',
  );
  const handler = source.match(
    /async function handleUpdateMyProfile[\s\S]*?\n}\n\nasync function handleChangeMyPassword/,
  )?.[0] || '';
  assert.match(handler, /updates\.share_read_receipts === false/);
  assert.match(handler, /withDbTransaction\(async \(transactionQuery\)/);
  assert.match(handler, /DELETE_HUMAN_READ_MARKERS_SQL/);
  assert.match(
    source,
    /body\?\.share_read_receipts !== undefined[\s\S]*forwardReadReceiptControl\(req, pathname, body\)/,
  );
});
