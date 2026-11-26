'use strict';

// ============================================================================
// tests/public-workspace-netlify.test.cjs
// ----------------------------------------------------------------------------
// The Netlify mirror serves the same public reads through the same shared
// reader, answers 501 for the stream (Fly only, like websockets), keeps the
// identical 404 — including on the stream route, so the 501 cannot be used to
// ask whether a private workspace exists — and forwards the owner's controls
// to Fly rather than holding a second, unaudited implementation.
// ============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const PUBLIC_WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIVATE_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING_WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AGENT = '11111111-1111-4111-8111-111111111111';
const visibility = { [PUBLIC_WS]: 'public', [PRIVATE_WS]: 'private' };

let handler;
let policyRows = [];

test.before(async () => {
 process.env.AUTH_SECRET = 'public-ws-netlify-secret';
 mock.module('@netlify/database', {
  namedExports: {
   getDatabase: () => ({
    pool: {
     async query(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('insert into rate_limits')) return { rows: [{ count: 1 }] };
      if (q.startsWith('select id, name, description, icon, visibility from workspaces')) {
       const v = visibility[params[0]];
       return { rows: v ? [{ id: params[0], name: 'Agent Expo', description: 'The hall', icon: 'H', visibility: v }] : [] };
      }
      if (q.startsWith('select event_type, level, detail from workspace_public_policy')) return { rows: policyRows };
      if (q.startsWith('select id, name, avatar, accent_color, run_mode, enabled, sharing from workspace_agents')) {
       return { rows: [{ id: AGENT, name: 'Scout', avatar: 'SC', accent_color: '#ff7a59', run_mode: 'builtin', enabled: true, sharing: {} }] };
      }
      if (q.startsWith('select agent_id, status, capabilities')) return { rows: [] };
      if (q.startsWith('select * from marketplace_listings')) {
       return { rows: [{ id: 'l1', slug: 'scout', listing_type: 'hire', name: 'Scout', status: 'published', capabilities: ['search'], publisher_workspace_id: PRIVATE_WS }] };
      }
      throw new Error(`Unexpected public-workspace query: ${sql}`);
     },
    },
   }),
  },
 });
 const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
 handler = backend.default;
});

async function get(pathname) {
 const response = await handler(new Request(`https://app.example.test${pathname}`));
 const headers = {};
 for (const [name, value] of response.headers) if (name !== 'date') headers[name] = value;
 return { status: response.status, headers, body: await response.text() };
}

test('netlify: a private workspace answers exactly like a missing or malformed one, stream included', async () => {
 for (const suffix of ['', '/events', '/stream']) {
  const answers = [];
  for (const id of [PRIVATE_WS, MISSING_WS, 'not-a-uuid']) answers.push(await get(`/backend/public/workspaces/${id}${suffix}`));
  assert.equal(answers[0].status, 404, `private ${suffix}`);
  assert.deepEqual(answers[1], answers[0]);
  assert.deepEqual(answers[2], answers[0]);
  assert.equal(answers[0].headers['cache-control'], 'no-store, max-age=0');
 }
});

test('netlify: a public workspace serves the summary and events, and answers 501 for the stream', async () => {
 const summary = await get(`/backend/public/workspaces/${PUBLIC_WS}`);
 assert.equal(summary.status, 200);
 assert.equal(summary.headers['access-control-allow-methods'], 'GET, OPTIONS');
 const body = JSON.parse(summary.body);
 assert.equal(body.roster, false);
 assert.deepEqual(body.agents, [], 'no policy row: no roster');
 assert.deepEqual(body.counts, { agents: 0, busy: 0, idle: 0, disconnected: 0 });
 assert.equal(summary.body.includes('Scout'), false);
 policyRows = [{ event_type: 'agent_roster', level: 'public', detail: 'category' }];
 try {
  const on = JSON.parse((await get(`/backend/public/workspaces/${PUBLIC_WS}`)).body);
  assert.equal(on.roster, true);
  assert.deepEqual(on.counts, { agents: 1, busy: 0, idle: 1, disconnected: 0 });
  // The roster never opens a private workspace.
  const privateAnswer = await get(`/backend/public/workspaces/${PRIVATE_WS}`);
  const missingAnswer = await get(`/backend/public/workspaces/${MISSING_WS}`);
  assert.equal(privateAnswer.status, 404);
  assert.deepEqual(missingAnswer, privateAnswer);
 } finally {
  policyRows = [];
 }
 const events = await get(`/backend/public/workspaces/${PUBLIC_WS}/events`);
 assert.equal(events.status, 200);
 assert.deepEqual(JSON.parse(events.body).events, []);
 const stream = await get(`/backend/public/workspaces/${PUBLIC_WS}/stream`);
 assert.equal(stream.status, 501);
 assert.equal(stream.headers['cache-control'], 'no-store, max-age=0');
});

test('netlify: public listings never carry the publisher', async () => {
 const listings = await get('/backend/public/marketplace/listings');
 assert.equal(listings.status, 200);
 assert.equal(listings.body.includes(PRIVATE_WS), false);
 assert.equal(JSON.parse(listings.body).listings[0].type, 'hire');
});

test('netlify: a non-GET on a public path is the same 404', async () => {
 const response = await handler(new Request(`https://app.example.test/backend/public/workspaces/${PUBLIC_WS}`, { method: 'POST' }));
 assert.equal(response.status, 404);
});

test('netlify: the owner controls are Fly-owned (forwarded), never a second implementation', () => {
 const source = fs.readFileSync(path.resolve(__dirname, '../netlify/functions/backend.mjs'), 'utf8');
 assert.match(source, /\(\?:visibility\|public-policy\)/);
 assert.equal(/insert into workspace_public_policy/i.test(source), false);
 assert.equal(/update workspaces set visibility/i.test(source), false);
});
