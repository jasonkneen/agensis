'use strict';

// NET-05 — paginated message history endpoint. Verifies the newest-page load,
// the (created_at,id) compound cursor for paging backwards, hasMore detection,
// ascending return order, retained/redacted deletion anchors, and auth.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

// A tiny in-memory messages store that answers the endpoint's exact queries:
//   - resolveWorkspaceIdForSession: select workspace_id from chat_sessions ...
//   - role check: select 1 from workspaces ... / select role from workspace_members ...
//   - the paginated select: order by created_at desc, id desc limit N (+ cursor)
function makeDb({ messages = [], sessionWorkspace = {}, roles = {}, owners = {}, authSecret = 'test-secret' }) {
  const settingRows = { AUTH_SECRET: authSecret };
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ q, params });
      if (q.startsWith('select value from app_settings')) {
        const v = settingRows[params[0]];
        return v ? [{ value: v }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select workspace_id') && q.includes('from chat_sessions')) {
        const ws = sessionWorkspace[params[0]];
        return ws ? [{ workspace_id: ws }] : [];
      }
      if (q.startsWith('select 1 from workspaces where id')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      if (q.includes('from messages') && q.includes('order by created_at desc, id desc')) {
        const sessionId = params[0];
        const before = params[1];
        const beforeId = params[2];
        const limitMatch = q.match(/limit (\d+)/);
        const lim = limitMatch ? Number(limitMatch[1]) : 201;
        let rows = messages.filter(m => m.session_id === sessionId);
        if (before) {
          rows = rows.filter(m => (m.created_at < before) || (beforeId && m.created_at === before && m.id < beforeId));
        }
        rows = rows.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : (a.id < b.id ? 1 : -1)));
        return rows.slice(0, lim);
      }
      return [];
    },
  };
  return db;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function authed(baseUrl, token, path) {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
}

// Build N messages 1ms apart, with two sharing a timestamp to exercise the cursor.
function seedMessages(sessionId, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const ts = new Date(1_700_000_000_000 + i * 1000).toISOString();
    out.push({ id: `m-${String(i).padStart(4, '0')}`, session_id: sessionId, content: `msg ${i}`, created_at: ts, deleted_at: null });
  }
  return out;
}

test.afterEach(() => __test.resetTestState());

test('returns the newest page ascending with hasMore when more remain', async () => {
  const messages = seedMessages('sess-1', 10);
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: { 'ws-1:user-1': 'editor' }, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    const res = await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=4');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.hasMore, true);
    assert.equal(body.data.messages.length, 4);
    // Ascending within the page, and it is the NEWEST 4 (msg 6..9).
    assert.deepEqual(body.data.messages.map(m => m.content), ['msg 6', 'msg 7', 'msg 8', 'msg 9']);
  });
});

test('paging backwards with before+beforeId returns the previous page, no gaps', async () => {
  const messages = seedMessages('sess-1', 10);
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: { 'ws-1:user-1': 'editor' }, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    // First page = newest 4 (msg 6..9). Oldest loaded = msg 6.
    const first = await (await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=4')).json();
    const oldest = first.data.messages[0];
    const res = await authed(baseUrl, token, `/backend/sessions/sess-1/messages?limit=4&before=${encodeURIComponent(oldest.created_at)}&beforeId=${oldest.id}`);
    const body = await res.json();
    assert.deepEqual(body.data.messages.map(m => m.content), ['msg 2', 'msg 3', 'msg 4', 'msg 5']);
    assert.equal(body.data.hasMore, true);
  });
});

test('hasMore is false on the final page', async () => {
  const messages = seedMessages('sess-1', 3);
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: { 'ws-1:user-1': 'editor' }, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    const body = await (await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=10')).json();
    assert.equal(body.data.hasMore, false);
    assert.equal(body.data.messages.length, 3);
    assert.deepEqual(body.data.messages.map(m => m.content), ['msg 0', 'msg 1', 'msg 2']);
  });
});

test('a same-timestamp boundary row is not skipped by the compound cursor', async () => {
  // Two messages share a created_at; the cursor must page across them cleanly.
  const ts = new Date(1_700_000_500_000).toISOString();
  const messages = [
    { id: 'm-a', session_id: 'sess-1', content: 'A', created_at: ts, deleted_at: null },
    { id: 'm-b', session_id: 'sess-1', content: 'B', created_at: ts, deleted_at: null },
    { id: 'm-c', session_id: 'sess-1', content: 'C', created_at: new Date(1_700_000_501_000).toISOString(), deleted_at: null },
  ];
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: { 'ws-1:user-1': 'editor' }, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    // Page size 2 → first page is [B, C] (newest two). Oldest loaded = B (same ts as A).
    const first = await (await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=2')).json();
    assert.deepEqual(first.data.messages.map(m => m.content), ['B', 'C']);
    const b = first.data.messages[0];
    const second = await (await authed(baseUrl, token, `/backend/sessions/sess-1/messages?limit=2&before=${encodeURIComponent(b.created_at)}&beforeId=${b.id}`)).json();
    // A shares B's timestamp but has a smaller id — it must appear, not be skipped.
    assert.deepEqual(second.data.messages.map(m => m.content), ['A']);
  });
});

test('retains a soft-deleted row as a body-free structural tombstone', async () => {
  const messages = seedMessages('sess-1', 3);
  messages[1].deleted_at = new Date().toISOString();
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: { 'ws-1:user-1': 'editor' }, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    const body = await (await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=10')).json();
    assert.deepEqual(body.data.messages.map(m => m.id), ['m-0000', 'm-0001', 'm-0002']);
    assert.equal(body.data.messages[1].content, 'This message was deleted.');
    assert.ok(body.data.messages[1].deleted_at);
  });
});

test('requires auth and workspace read access', async () => {
  const messages = seedMessages('sess-1', 3);
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: {}, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    // No token → 401
    const noAuth = await fetch(`${baseUrl}/backend/sessions/sess-1/messages`);
    assert.equal(noAuth.status, 401);
    // Authed but not a workspace member → 403
    const token = await __test.issueToken('user-nobody', '1');
    const forbidden = await authed(baseUrl, token, '/backend/sessions/sess-1/messages');
    assert.equal(forbidden.status, 403);
  });
});

test('unknown session returns 404', async () => {
  __test.setTestDb(makeDb({ messages: [], sessionWorkspace: {}, roles: {}, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    const res = await authed(baseUrl, token, '/backend/sessions/ghost/messages');
    assert.equal(res.status, 404);
  });
});

test('a fractional or invalid limit is coerced to a safe integer', async () => {
  const messages = seedMessages('sess-1', 10);
  __test.setTestDb(makeDb({ messages, sessionWorkspace: { 'sess-1': 'ws-1' }, roles: { 'ws-1:user-1': 'editor' }, authSecret: 'fixed' }));
  await withServer(async (baseUrl) => {
    const token = await __test.issueToken('user-1', '1');
    // limit=1.5 must not reach SQL as `limit 2.5` (Postgres would 500). Truncated to 1.
    const res = await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=1.5');
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.messages.length, 1);
    // limit=abc -> NaN -> default 200 (all 10 returned).
    const res2 = await authed(baseUrl, token, '/backend/sessions/sess-1/messages?limit=abc');
    const body2 = await res2.json();
    assert.equal(body2.data.messages.length, 10);
  });
});
