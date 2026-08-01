'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AUTH_SECRET = 'netlify-control-forwarding-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let handler;

test.before(async () => {
  process.env.AUTH_SECRET = AUTH_SECRET;
  delete process.env.AGENSIS_AUTH_SECRET;
  mock.module('@netlify/database', {
    exports: {
      getDatabase: () => ({
        pool: {
          async query(sql) {
            const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
            if (q.startsWith('alter table') || q.startsWith('create table')
              || q.startsWith('create index') || q.startsWith('create unique index')) {
              return { rows: [] };
            }
            if (q.startsWith('select token_version from app_users')) {
              return { rows: [{ token_version: '1' }] };
            }
            if (q.startsWith('select workspace_id from "chat_sessions" where id = $1')) {
              return { rows: [{ workspace_id: WORKSPACE }] };
            }
            if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id = $1')) {
              return {
                rows: [{
                  id: SESSION,
                  visibility: 'workspace',
                  folder: 'Channels',
                  deleted_at: null,
                }],
              };
            }
            if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
              return { rows: [{ ok: 1 }] };
            }
            throw new Error(`Unexpected control-forwarding query: ${sql}`);
          },
        },
      }),
    },
  });
  const backend = await import(
    pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href
  );
  handler = backend.default;
});

test.afterEach(() => {
  delete process.env.NETLIFY;
  delete process.env.CONTEXT;
  delete process.env.DEPLOY_PRIME_URL;
  delete process.env.AGENSIS_DAEMON_BASE_URL;
  delete process.env.AGENSIS_WS_BASE_URL;
});

function token() {
  const payload = `${USER}.1.${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function closeRequest(origin = 'https://app.example.test', bearer = token()) {
  return new Request(`${origin}/backend/sessions/${SESSION}/close`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
  });
}

function genericCloseRequest(origin = 'https://app.example.test', bearer = token()) {
  return new Request(`${origin}/backend/db/update`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      table: 'chat_sessions',
      values: { deleted_at: '2026-07-31T12:00:00.000Z' },
      filters: [{ column: 'id', operator: 'eq', value: SESSION }],
      returning: 'id',
      single: true,
    }),
  });
}

test('a deployed same-origin daemon URL fails closed without recursive forwarding', async () => {
  process.env.NETLIFY = 'true';
  process.env.AGENSIS_DAEMON_BASE_URL = 'https://app.example.test';
  const originalFetch = globalThis.fetch;
  let forwarded = false;
  globalThis.fetch = async () => {
    forwarded = true;
    throw new Error('recursive forwarding must not be attempted');
  };
  try {
    const response = await handler(closeRequest());
    assert.equal(response.status, 503, await response.clone().text());
    const body = await response.json();
    assert.match(body.error.message, /must not point back to netlify/i);
    assert.equal(forwarded, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a deployed control request forwards to the distinct long-running backend', async () => {
  process.env.NETLIFY = 'true';
  process.env.AGENSIS_DAEMON_BASE_URL = 'https://control.example.test/';
  const bearer = token();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { closed: true }, error: null }), {
      status: 207,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const response = await handler(closeRequest('https://app.example.test', bearer));
    assert.equal(response.status, 207);
    assert.deepEqual(await response.json(), { data: { closed: true }, error: null });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://control.example.test/backend/sessions/${SESSION}/close`);
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${bearer}`);
});

test('a partial-returning generic close is forwarded intact for authoritative Fly fanout', async () => {
  process.env.NETLIFY = 'true';
  process.env.AGENSIS_DAEMON_BASE_URL = 'https://control.example.test/';
  const bearer = token();
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify({ data: { id: SESSION }, error: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const response = await handler(genericCloseRequest('https://app.example.test', bearer));
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(await response.json(), { data: { id: SESSION }, error: null });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://control.example.test/backend/db/update');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${bearer}`);
  assert.deepEqual(JSON.parse(String(calls[0].options.body)), {
    table: 'chat_sessions',
    values: { deleted_at: '2026-07-31T12:00:00.000Z' },
    filters: [{ column: 'id', operator: 'eq', value: SESSION }],
    returning: 'id',
    single: true,
  });
});
