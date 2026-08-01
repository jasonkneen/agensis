'use strict';

// Netlify is an HTTP mirror, but unified join redemption remains owned by the
// long-running backend: it is the only lane with the one-use transaction,
// realtime fanout, and controller credential issuer. These tests pin the
// forwarding edge so an explicit Netlify backend base cannot degrade a valid
// invite into a 404 or drop machine JSON negotiation on the way to Fly.

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let handler;
let originalFetch;
const requests = [];

test.before(async () => {
 process.env.AUTH_SECRET = 'netlify-join-forwarding-test-secret';
 process.env.AGENSIS_DAEMON_BASE_URL = 'https://agensis-backend.example.test/';
 mock.module('@netlify/database', {
  namedExports: {
   getDatabase: () => ({
    pool: {
     async query() {
      return { rows: [] };
     },
    },
   }),
  },
 });
 const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
 handler = backend.default;
 originalFetch = global.fetch;
 global.fetch = async (url, init) => {
  requests.push({ url: String(url), init });
  return new Response(JSON.stringify({ data: { forwarded: true }, error: null }), {
   status: 200,
   headers: {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex, nofollow',
   },
  });
 };
});

test.after(() => {
 global.fetch = originalFetch;
 delete process.env.AGENSIS_DAEMON_BASE_URL;
 delete process.env.AUTH_SECRET;
});

test('Netlify forwards machine-readable join requests with query and security headers intact', async () => {
 const token = `agj_${'a'.repeat(43)}`;
 const response = await handler(new Request(
  `https://app.example.test/backend/join/${token}?format=json`,
  { headers: { Accept: 'application/json' } },
 ));

 assert.equal(response.status, 200);
 assert.deepEqual(await response.json(), { data: { forwarded: true }, error: null });
 assert.equal(requests.length, 1);
 assert.equal(requests[0].url, `https://agensis-backend.example.test/backend/join/${token}?format=json`);
 assert.equal(requests[0].init.method, 'GET');
 assert.equal(requests[0].init.headers.accept, 'application/json');
 assert.equal(response.headers.get('cache-control'), 'no-store');
 assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
 assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow');
});

test('Netlify forwards authenticated join-link management writes without minting locally', async () => {
 requests.length = 0;
 const response = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/join-links',
  {
   method: 'POST',
   headers: {
    Authorization: 'Bearer user-session',
    'Content-Type': 'application/json',
   },
   body: JSON.stringify({ audience: 'both', role: 'editor' }),
  },
 ));

 assert.equal(response.status, 200);
 assert.equal(requests.length, 1);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/join-links');
 assert.equal(requests[0].init.method, 'POST');
 assert.equal(requests[0].init.headers.authorization, 'Bearer user-session');
 assert.deepEqual(JSON.parse(requests[0].init.body), { audience: 'both', role: 'editor' });
});

test('Netlify forwards the one-use agent redemption body without adding an Authorization header', async () => {
 requests.length = 0;
 const token = `agj_${'b'.repeat(43)}`;
 const response = await handler(new Request(
  `https://app.example.test/backend/join/${token}/redeem`,
  {
   method: 'POST',
   headers: { 'Content-Type': 'application/json' },
   body: JSON.stringify({ as: 'agent', name: 'Build worker' }),
  },
 ));

 assert.equal(response.status, 200);
 assert.equal(requests.length, 1);
 assert.equal(requests[0].url, `https://agensis-backend.example.test/backend/join/${token}/redeem`);
 assert.equal(requests[0].init.method, 'POST');
 assert.equal(requests[0].init.headers.authorization, '');
 assert.deepEqual(JSON.parse(requests[0].init.body), { as: 'agent', name: 'Build worker' });
});

test('Netlify forwards controller list and revoke calls to the owner-gated Fly route', async () => {
 requests.length = 0;
 const listResponse = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/controllers',
  { headers: { Authorization: 'Bearer owner-session' } },
 ));
 assert.equal(listResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/controllers');
 assert.equal(requests[0].init.method, 'GET');
 assert.equal(requests[0].init.headers.authorization, 'Bearer owner-session');

 requests.length = 0;
 const revokeResponse = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/controllers/controller-7',
  { method: 'DELETE', headers: { Authorization: 'Bearer owner-session' } },
 ));
 assert.equal(revokeResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/controllers/controller-7');
 assert.equal(requests[0].init.method, 'DELETE');
 assert.equal(requests[0].init.headers.authorization, 'Bearer owner-session');
});

test('Netlify forwards legacy member and invite collection paths to the canonical Fly routes', async () => {
 requests.length = 0;
 const memberResponse = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/members',
  { headers: { Authorization: 'Bearer owner-session' } },
 ));
 assert.equal(memberResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/members');
 assert.equal(requests[0].init.headers.authorization, 'Bearer owner-session');

 requests.length = 0;
 const inviteResponse = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/invites',
  { method: 'POST', headers: {
   Authorization: 'Bearer owner-session',
   'Content-Type': 'application/json',
  }, body: JSON.stringify({ role: 'editor', email: 'person@example.test' }) },
 ));
 assert.equal(inviteResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/invites');
 assert.equal(requests[0].init.method, 'POST');
 assert.deepEqual(JSON.parse(requests[0].init.body), { role: 'editor', email: 'person@example.test' });
});

test('Netlify forwards the legacy invite accept path with the caller session', async () => {
 requests.length = 0;
 const response = await handler(new Request(
  'https://app.example.test/backend/invites/legacy-token/accept',
  { method: 'POST', headers: {
   Authorization: 'Bearer member-session',
   'Content-Type': 'application/json',
  }, body: JSON.stringify({}) },
 ));
 assert.equal(response.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/invites/legacy-token/accept');
 assert.equal(requests[0].init.method, 'POST');
 assert.equal(requests[0].init.headers.authorization, 'Bearer member-session');
});

test('Netlify forwards live agent controls and the manage-gated audit reader', async () => {
 requests.length = 0;
 const disconnectResponse = await handler(new Request(
  'https://app.example.test/backend/agents/agent-1/disconnect',
  { method: 'POST', headers: { Authorization: 'Bearer owner-session' } },
 ));
 assert.equal(disconnectResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/agents/agent-1/disconnect');
 assert.equal(requests[0].init.headers.authorization, 'Bearer owner-session');

 requests.length = 0;
 const auditResponse = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/audit?limit=10',
  { headers: { Authorization: 'Bearer owner-session' } },
 ));
 assert.equal(auditResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/audit?limit=10');
 assert.equal(requests[0].init.method, 'GET');
});

test('Netlify forwards authored template writes and public webhook triggers', async () => {
 requests.length = 0;
 const templateResponse = await handler(new Request(
  'https://app.example.test/backend/workspaces/ws-1/agent-templates/import',
  { method: 'POST', headers: {
   Authorization: 'Bearer owner-session',
   'Content-Type': 'application/json',
  }, body: JSON.stringify({ export: { slug: 'pack' } }) },
 ));
 assert.equal(templateResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/workspaces/ws-1/agent-templates/import');
 assert.deepEqual(JSON.parse(requests[0].init.body), { export: { slug: 'pack' } });

 requests.length = 0;
 const webhookResponse = await handler(new Request(
  'https://app.example.test/backend/webhooks/webhook-token',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: 'run' }) },
 ));
 assert.equal(webhookResponse.status, 200);
 assert.equal(requests[0].url, 'https://agensis-backend.example.test/backend/webhooks/webhook-token');
 assert.equal(requests[0].init.headers.authorization, '');
 assert.deepEqual(JSON.parse(requests[0].init.body), { prompt: 'run' });
});

test('Netlify forwards the remaining Fly-owned workspace and conversation surfaces', async () => {
 const cases = [
  ['GET', 'https://app.example.test/backend/workspaces/ws-1/bootstrap', undefined],
  ['GET', 'https://app.example.test/backend/sessions/session-1/messages?limit=20', undefined],
  ['POST', 'https://app.example.test/backend/workspaces/ws-1/sessions/session-1/huddle', { title: 'Planning' }],
  ['GET', 'https://app.example.test/backend/workspaces/ws-1/gateways', undefined],
  ['POST', 'https://app.example.test/backend/files/upload', { name: 'notes.txt' }],
  ['POST', 'https://app.example.test/backend/schedules/schedule-1/run', {}],
  ['GET', 'https://app.example.test/backend/tts/voices', undefined],
  ['POST', 'https://app.example.test/backend/link-previews', { url: 'https://example.test' }],
  ['POST', 'https://app.example.test/backend/bridges', { sessionId: 'session-1', provider: 'slack' }],
  ['POST', 'https://app.example.test/backend/integrations/farm/device/approve', { code: 'abc' }],
  ['GET', 'https://app.example.test/backend/skill?format=json', undefined],
  ['POST', 'https://app.example.test/backend/workspaces/ws-1/flow-connections', { targetUrl: 'https://example.test/hook' }],
  ['POST', 'https://app.example.test/backend/workspaces/ws-1/mcp-token', { label: 'desktop' }],
  ['GET', 'https://app.example.test/backend/workspaces/ws-1/agent-registrations?status=pending', undefined],
  ['POST', 'https://app.example.test/backend/agent-registrations/registration-1/approve', {}],
  ['POST', 'https://app.example.test/backend/agensis/setup/connect', { workspaceId: 'ws-1' }],
  ['POST', 'https://app.example.test/backend/agents/agent-1/connection-command', { runtime: 'codex' }],
];
 for (const [method, url, body] of cases) {
  requests.length = 0;
  const response = await handler(new Request(url, {
   method,
   headers: {
    Authorization: 'Bearer user-session',
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
   },
   ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  assert.equal(response.status, 200, `${method} ${url}`);
  assert.equal(requests[0].url, url.replace('https://app.example.test', 'https://agensis-backend.example.test'));
  assert.equal(requests[0].init.method, method);
  assert.equal(requests[0].init.headers.authorization, 'Bearer user-session');
  if (body !== undefined) assert.deepEqual(JSON.parse(requests[0].init.body), body);
 }
});
