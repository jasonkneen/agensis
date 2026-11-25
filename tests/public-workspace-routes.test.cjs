'use strict';

// ============================================================================
// tests/public-workspace-routes.test.cjs
// ----------------------------------------------------------------------------
// The public workspace routes on the Fly server, driven through the real
// express app: the identical 404 (no oracle), the no-store/GET-only headers,
// the manage gate and audit rows on the owner's controls, the generic-write
// column guard, the rate limit, and the SSE stream closing when a workspace
// stops being public. The projection rules themselves are pinned in
// tests/public-workspace.test.cjs.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');
const { stripPrivilegedDbValues } = require('../shared/backend-core.cjs');

const USER = '33333333-3333-4333-8333-333333333333';
const PUBLIC_WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIVATE_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING_WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AGENT = '11111111-1111-4111-8111-111111111111';

test.afterEach(() => __test.resetTestState());

function makeDb({ role = 'owner', visibility = { [PUBLIC_WS]: 'public', [PRIVATE_WS]: 'private' } } = {}) {
 const state = { visibility: { ...visibility }, policy: [], audits: [], writes: [] };
 const db = {
  state,
  async unsafe(sql, params = []) {
   const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
   if (q.startsWith('insert into audit_log')) {
    state.audits.push(params);
    return [{ id: `audit-${state.audits.length}`, seq: state.audits.length, entry_hash: params[12] }];
   }
   if (q.startsWith('insert into rate_limits')) return [{ count: 1 }];
   if (q.startsWith('select value from app_settings')) return params[0] === 'AUTH_SECRET' ? [{ value: 'public-ws-secret' }] : [];
   if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
   if (q.startsWith('select id, user_id from workspaces where id')) return [{ id: params[0], user_id: USER }];
   if (q.startsWith('select 1 from workspaces where id')) return role === 'owner' && String(params[1]) === USER ? [{ ok: 1 }] : [];
   if (q.startsWith('select role from workspace_members')) return role && role !== 'owner' && role !== 'none' ? [{ role }] : [];
   if (q.includes('with recursive chain as')) return [];
   if (q.startsWith('select id, name, description, icon, visibility from workspaces')) {
    const v = state.visibility[params[0]];
    return v ? [{ id: params[0], name: 'Agent Expo', description: 'The hall', icon: 'H', visibility: v }] : [];
   }
   if (q.startsWith('select visibility from workspaces')) {
    const v = state.visibility[params[0]];
    return v ? [{ visibility: v }] : [];
   }
   if (q.startsWith('update workspaces set visibility')) {
    state.writes.push(['visibility', params]);
    state.visibility[params[0]] = params[1];
    return [];
   }
   if (q.startsWith('select event_type, level, detail from workspace_public_policy')) return state.policy;
   if (q.startsWith('select event_type, level, detail, updated_at from workspace_public_policy')) return state.policy;
   if (q.startsWith('select level, detail from workspace_public_policy')) {
    return state.policy.filter((row) => row.event_type === params[1]);
   }
   if (q.startsWith('insert into workspace_public_policy')) {
    state.writes.push(['policy', params]);
    state.policy = state.policy.filter((row) => row.event_type !== params[1]);
    state.policy.push({ event_type: params[1], level: params[2], detail: params[3], updated_at: 'now' });
    return [];
   }
   if (q.startsWith('delete from workspace_public_policy')) {
    const removed = state.policy.filter((row) => row.event_type === params[1]);
    state.policy = state.policy.filter((row) => row.event_type !== params[1]);
    return removed;
   }
   if (q.startsWith('select id, name, avatar, accent_color, run_mode, enabled, sharing from workspace_agents')) {
    return [{ id: AGENT, name: 'Scout', avatar: 'SC', accent_color: '#ff7a59', run_mode: 'daemon', enabled: true, sharing: {} }];
   }
   if (q.startsWith('select agent_id, status, capabilities')) return [{ agent_id: AGENT, status: 'online', share_policy: null }];
   if (q.startsWith('select e.id::text as id')) return [];
   if (q.startsWith('select * from marketplace_listings')) {
    return [{ id: 'l1', slug: 'scout', listing_type: 'template', name: 'Scout', status: 'published', system_prompt: 'PROMPT-SENTINEL', publisher_workspace_id: PRIVATE_WS }];
   }
   // Boot-time DDL and unrelated background statements answer empty.
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
  server.closeAllConnections?.();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
 }
}

function comparableHeaders(response) {
 const out = {};
 for (const [name, value] of response.headers) {
  if (name === 'date' || name === 'keep-alive' || name === 'connection') continue;
  out[name] = value;
 }
 return out;
}

async function snapshot(response) {
 return { status: response.status, headers: comparableHeaders(response), body: await response.text() };
}

test('a private workspace answers exactly like a missing or malformed one, on every public route', async () => {
 __test.setTestDb(makeDb());
 await withServer(async (base) => {
  for (const suffix of ['', '/events', '/events?since=2026-11-25T00:00:00Z', '/stream']) {
   const answers = [];
   for (const id of [PRIVATE_WS, MISSING_WS, 'not-a-uuid']) {
    answers.push(await snapshot(await fetch(`${base}/backend/public/workspaces/${id}${suffix}`)));
   }
   assert.equal(answers[0].status, 404, `private ${suffix}`);
   assert.deepEqual(answers[1], answers[0], `missing vs private on ${suffix || 'summary'}`);
   assert.deepEqual(answers[2], answers[0], `malformed vs private on ${suffix || 'summary'}`);
   assert.equal(answers[0].headers['cache-control'], 'no-store, max-age=0');
   assert.equal(answers[0].body.includes('Agent Expo'), false);
  }
 });
});

test('a public workspace answers its summary with no-store and GET-only CORS', async () => {
 __test.setTestDb(makeDb());
 await withServer(async (base) => {
  const response = await fetch(`${base}/backend/public/workspaces/${PUBLIC_WS}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  assert.equal(response.headers.get('access-control-allow-origin'), '*');
  assert.equal(response.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
  const body = await response.json();
  assert.deepEqual(body.counts, { agents: 1, busy: 0, idle: 1, disconnected: 0 });
  assert.deepEqual(Object.keys(body).sort(), ['agents', 'counts', 'description', 'icon', 'id', 'name']);
  const events = await (await fetch(`${base}/backend/public/workspaces/${PUBLIC_WS}/events`)).json();
  assert.deepEqual(events.events, [], 'no policy row: nothing leaves');
 });
});

test('public marketplace listings never carry persona prose or the publisher', async () => {
 __test.setTestDb(makeDb());
 await withServer(async (base) => {
  const response = await fetch(`${base}/backend/public/marketplace/listings`);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.equal(text.includes('PROMPT-SENTINEL'), false);
  assert.equal(text.includes(PRIVATE_WS), false);
  assert.equal(JSON.parse(text).listings[0].type, 'template');
 });
});

test('the public routes are rate limited per IP, and the 429 is no-store too', async () => {
 __test.setTestDb(makeDb());
 await withServer(async (base) => {
  let last;
  for (let i = 0; i < 121; i += 1) last = await fetch(`${base}/backend/public/workspaces/${MISSING_WS}`);
  assert.equal(last.status, 429);
  assert.equal(last.headers.get('cache-control'), 'no-store, max-age=0');
  assert.ok(Number(last.headers.get('retry-after')) >= 1);
 });
});

function call(base, method, path, token, body) {
 return fetch(`${base}${path}`, {
  method,
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
 });
}

test('changing visibility needs manage and writes workspace.visibility_changed', async () => {
 const viewerDb = makeDb({ role: 'viewer' });
 __test.setTestDb(viewerDb);
 let token = await __test.issueToken(USER, '1');
 await withServer(async (base) => {
  const refused = await call(base, 'PATCH', `/backend/workspaces/${PRIVATE_WS}/visibility`, token, { visibility: 'public' });
  assert.equal(refused.status, 403);
 });
 assert.equal(viewerDb.state.visibility[PRIVATE_WS], 'private');
 assert.equal(viewerDb.state.audits.length, 0);

 __test.resetTestState();
 const ownerDb = makeDb();
 __test.setTestDb(ownerDb);
 token = await __test.issueToken(USER, '1');
 await withServer(async (base) => {
  const bad = await call(base, 'PATCH', `/backend/workspaces/${PRIVATE_WS}/visibility`, token, { visibility: 'everyone' });
  assert.equal(bad.status, 400);
  const ok = await call(base, 'PATCH', `/backend/workspaces/${PRIVATE_WS}/visibility`, token, { visibility: 'public' });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).data.visibility, 'public');
  // Unchanged: no second row.
  await call(base, 'PATCH', `/backend/workspaces/${PRIVATE_WS}/visibility`, token, { visibility: 'public' });
 });
 assert.equal(ownerDb.state.audits.length, 1);
 const [workspaceId, actorUserId, , , action, , , , before, after] = ownerDb.state.audits[0];
 assert.equal(workspaceId, PRIVATE_WS);
 assert.equal(actorUserId, USER);
 assert.equal(action, 'workspace.visibility_changed');
 assert.equal(before, 'private');
 assert.equal(after, 'public');
});

test('policy writes need manage, refuse unknown values, and write workspace.public_policy_changed', async () => {
 const viewerDb = makeDb({ role: 'member' });
 __test.setTestDb(viewerDb);
 let token = await __test.issueToken(USER, '1');
 await withServer(async (base) => {
  const refused = await call(base, 'PUT', `/backend/workspaces/${PUBLIC_WS}/public-policy`, token, { eventType: 'task_created', level: 'public', detail: 'title' });
  assert.equal(refused.status, 403);
  const read = await call(base, 'GET', `/backend/workspaces/${PUBLIC_WS}/public-policy`, token);
  assert.equal(read.status, 403);
 });
 assert.equal(viewerDb.state.writes.length, 0);

 __test.resetTestState();
 const ownerDb = makeDb();
 __test.setTestDb(ownerDb);
 token = await __test.issueToken(USER, '1');
 await withServer(async (base) => {
  for (const body of [
   { eventType: 'provider_call', level: 'public', detail: 'full' },
   { eventType: 'task_created', level: 'world', detail: 'title' },
   { eventType: 'task_created', level: 'public', detail: 'everything' },
  ]) {
   assert.equal((await call(base, 'PUT', `/backend/workspaces/${PUBLIC_WS}/public-policy`, token, body)).status, 400);
  }
  const ok = await call(base, 'PUT', `/backend/workspaces/${PUBLIC_WS}/public-policy`, token, { eventType: 'task_created', level: 'public', detail: 'title' });
  assert.equal(ok.status, 200);
  const state = (await ok.json()).data;
  assert.deepEqual(state.policies.map((row) => [row.eventType, row.level, row.detail]), [['task_created', 'public', 'title']]);
  assert.ok(state.eventTypes.some((row) => row.eventType === 'memory_added' && row.ceiling === 'category'));
  const removed = await call(base, 'DELETE', `/backend/workspaces/${PUBLIC_WS}/public-policy/task_created`, token);
  assert.equal(removed.status, 200);
 });
 assert.equal(ownerDb.state.writes.filter(([kind]) => kind === 'policy').length, 1);
 assert.deepEqual(ownerDb.state.audits.map((params) => [params[4], params[8], params[9]]), [
  ['workspace.public_policy_changed', 'none', 'public/title'],
  ['workspace.public_policy_changed', 'public/title', 'none'],
 ]);
});

test('a generic /backend/db write cannot set workspaces.visibility', () => {
 const out = stripPrivilegedDbValues('workspaces', { name: 'Renamed', visibility: 'public' });
 assert.deepEqual(out, { name: 'Renamed' });
});

test('the stream opens with a snapshot and closes when the workspace stops being public', async () => {
 const db = makeDb();
 __test.setTestDb(db);
 await withServer(async (base) => {
  const controller = new AbortController();
  const response = await fetch(`${base}/backend/public/workspaces/${PUBLIC_WS}/stream`, { signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('cache-control'), 'no-store, max-age=0');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (!text.includes('\n\n')) {
   const { value, done } = await reader.read();
   if (done) break;
   text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /^event: snapshot\ndata: /);
  const snapshotData = JSON.parse(text.split('\n')[1].slice('data: '.length));
  assert.equal(snapshotData.id, PUBLIC_WS);

  // The room exists once its first join has settled.
  for (let i = 0; i < 50 && !__test.publicStreamHub.rooms.has(PUBLIC_WS); i += 1) {
   await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(__test.publicStreamHub.rooms.has(PUBLIC_WS), true);

  db.state.visibility[PUBLIC_WS] = 'private';
  await __test.publicStreamHub.tick(PUBLIC_WS);
  let done = false;
  while (!done) ({ done } = await reader.read());
  assert.equal(done, true, 'the stream ended');
  assert.equal(__test.publicStreamHub.rooms.has(PUBLIC_WS), false, 'its poller stopped');
  controller.abort();
 });
});
