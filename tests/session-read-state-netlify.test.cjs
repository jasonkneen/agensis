'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AUTH_SECRET = 'netlify-receipt-authority-secret';
const OWNER = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let handler;
const queries = [];
const transactionEvents = [];
let failMarkerDelete = false;

const REMOVED_MARKER = {
  marker_id: '33333333-3333-4333-8333-333333333333',
  event_version: '19',
  session_id: SESSION,
  user_id: OWNER,
  agent_id: null,
  thread_parent_id: null,
  last_seen_message_id: '44444444-4444-4444-8444-444444444444',
  read_at: '2026-07-31T10:00:00.000Z',
};

function normalizeQuery(sql) {
  const normalized = String(sql).replace(/\s+/g, ' ').trim();
  return { normalized, q: normalized.toLowerCase() };
}

async function executeQuery(sql, params = [], lane = 'pool') {
  const { normalized, q } = normalizeQuery(sql);
  queries.push({ sql: normalized, q, params, lane });
  if (lane === 'transaction') transactionEvents.push(q);
  if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
  if (q.startsWith('alter table') || q.startsWith('create table')
    || q.startsWith('create index') || q.startsWith('create unique index')) {
    return { rows: [] };
  }
  if (q.startsWith('select token_version from app_users')) {
    return { rows: [{ token_version: '1' }] };
  }
  if (q.startsWith('update app_users set')) {
    return {
      rows: [{
        id: OWNER,
        email: 'owner@example.test',
        display_name: 'Owner',
        accent_color: '#123456',
        share_read_receipts: Boolean(params[1]),
        created_at: '2026-07-31T00:00:00.000Z',
      }],
    };
  }
  if (q.startsWith('delete from session_read_state')) {
    if (failMarkerDelete) throw new Error('forced marker deletion failure');
    return { rows: [{ ...REMOVED_MARKER }] };
  }
  throw new Error(`Receipt mutation unexpectedly reached Netlify database: ${normalized}`);
}

const pool = {
  on() {},
  query(sql, params = []) {
    return executeQuery(sql, params, 'pool');
  },
  async connect() {
    transactionEvents.push('connect');
    return {
      query(sql, params = []) {
        return executeQuery(sql, params, 'transaction');
      },
      release() {
        transactionEvents.push('release');
      },
    };
  },
};

test.before(async () => {
  process.env.AUTH_SECRET = AUTH_SECRET;
  delete process.env.AGENSIS_AUTH_SECRET;
  mock.module('@netlify/database', {
    exports: {
      getDatabase: () => ({
        pool,
      }),
    },
  });
  const backend = await import(
    pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href
  );
  handler = backend.default;
});

function token() {
  const payload = `${OWNER}.1.${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function dbRequest(route, body) {
  return handler(new Request(`http://localhost/backend/db/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function profileRequest(body, origin = 'http://localhost', bearer = token()) {
  return handler(new Request(`${origin}/backend/users/me`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }));
}

function setNetlifyRuntime({ deployed = false, daemonBaseUrl = '' } = {}) {
  for (const name of [
    'NETLIFY', 'CONTEXT', 'DEPLOY_PRIME_URL',
    'AGENSIS_DAEMON_BASE_URL', 'AGENSIS_WS_BASE_URL',
  ]) delete process.env[name];
  if (deployed) process.env.NETLIFY = 'true';
  if (daemonBaseUrl) process.env.AGENSIS_DAEMON_BASE_URL = daemonBaseUrl;
}

test.beforeEach(() => {
  queries.length = 0;
  transactionEvents.length = 0;
  failMarkerDelete = false;
  setNetlifyRuntime();
});

test('Netlify refuses generic receipt insert, update, and delete even for an owner', async () => {
  const attempts = [
    {
      route: 'insert',
      body: {
        table: 'session_read_state',
        values: {
          session_id: SESSION,
          user_id: MEMBER,
          marker_id: '55555555-5555-4555-8555-555555555555',
          event_version: '999',
          thread_parent_id: null,
          last_seen_message_id: '66666666-6666-4666-8666-666666666666',
          read_at: '2099-01-01T00:00:00.000Z',
        },
      },
    },
    {
      route: 'update',
      body: {
        table: 'session_read_state',
        values: {
          event_version: '999',
          last_seen_message_id: '66666666-6666-4666-8666-666666666666',
          read_at: '2099-01-01T00:00:00.000Z',
        },
        filters: [{ column: 'session_id', operator: 'eq', value: SESSION }],
      },
    },
    {
      route: 'delete',
      body: {
        table: 'session_read_state',
        filters: [{ column: 'session_id', operator: 'eq', value: SESSION }],
      },
    },
  ];

  for (const attempt of attempts) {
    const response = await dbRequest(attempt.route, attempt.body);
    assert.equal(response.status, 403, `${attempt.route} must be unreachable to an owner`);
    assert.match((await response.json()).error.message, /dedicated read receipt route/i);
  }

  assert.equal(
    queries.some(entry => /^(insert into|update|delete from) session_read_state/i.test(entry.q)),
    false,
    'no generic receipt mutation reaches the Netlify database',
  );
});

test('deployed Netlify forwards receipt privacy changes to Fly with bearer and body intact', async () => {
  setNetlifyRuntime({ deployed: true, daemonBaseUrl: 'https://fly.example.test' });
  const forwarded = [];
  const bearer = token();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    forwarded.push({ url: String(url), init });
    return Response.json({
      data: { id: OWNER, share_read_receipts: false },
      error: null,
    });
  };

  try {
    const response = await profileRequest({ share_read_receipts: false }, 'http://localhost', bearer);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).data.share_read_receipts, false);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].url, 'https://fly.example.test/backend/users/me');
  assert.equal(forwarded[0].init.method, 'PATCH');
  assert.equal(forwarded[0].init.headers.authorization, `Bearer ${bearer}`);
  assert.deepEqual(JSON.parse(forwarded[0].init.body), { share_read_receipts: false });
  assert.equal(
    queries.some(entry => entry.q.startsWith('update app_users set')
      || entry.q.startsWith('delete from session_read_state')),
    false,
    'the serverless lane must not race Fly with a second local mutation',
  );
});

test('deployed Netlify fails closed when the Fly control-plane URL is missing', async () => {
  setNetlifyRuntime({ deployed: true });

  const response = await profileRequest({ share_read_receipts: false });
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.match(payload.error.message, /require the long-running backend/i);
  assert.deepEqual(payload.data, { requiredEnv: 'AGENSIS_DAEMON_BASE_URL' });
  assert.equal(transactionEvents.length, 0);
  assert.equal(
    queries.some(entry => entry.q.startsWith('update app_users set')
      || entry.q.startsWith('delete from session_read_state')),
    false,
  );
});

test('local Netlify fallback commits profile opt-out and marker deletion atomically', async () => {
  const response = await profileRequest({ share_read_receipts: false });
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal((await response.json()).data.share_read_receipts, false);
  assert.deepEqual(transactionEvents.map(event => {
    if (event.startsWith('update app_users set')) return 'update-profile';
    if (event.startsWith('delete from session_read_state')) return 'delete-markers';
    return event;
  }), ['connect', 'begin', 'update-profile', 'delete-markers', 'commit', 'release']);
});

test('local Netlify fallback rolls back when marker deletion fails', async () => {
  failMarkerDelete = true;

  const response = await profileRequest({ share_read_receipts: false });
  assert.equal(response.status, 500);
  assert.match((await response.json()).error.message, /forced marker deletion failure/);
  assert.deepEqual(transactionEvents.slice(0, 2), ['connect', 'begin']);
  assert.equal(transactionEvents[2].startsWith('update app_users set'), true);
  assert.equal(transactionEvents[3].startsWith('delete from session_read_state'), true);
  assert.deepEqual(transactionEvents.slice(4), ['rollback', 'release']);
  assert.equal(transactionEvents.includes('commit'), false);
});
