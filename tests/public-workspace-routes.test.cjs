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
   if (q.startsWith('select to_char(now()')) return [{ now: '2026-11-25T12:00:00.000000Z' }];
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
  const text = await response.text();
  const body = JSON.parse(text);
  assert.deepEqual(Object.keys(body).sort(), ['agents', 'counts', 'description', 'icon', 'id', 'name', 'roster']);
  assert.equal(body.name, 'Agent Expo', 'the name and description are the page identity and stay public');
  assert.equal(body.roster, false);
  assert.deepEqual(body.agents, [], 'no policy row: no roster');
  assert.deepEqual(body.counts, { agents: 0, busy: 0, idle: 0, disconnected: 0 }, 'no policy row: not even a count');
  assert.equal(text.includes('Scout'), false);
  assert.equal(text.includes(AGENT), false);
  const events = await (await fetch(`${base}/backend/public/workspaces/${PUBLIC_WS}/events`)).json();
  assert.deepEqual(events.events, [], 'no policy row: nothing leaves');
 });
});

test('the roster leaves only when the owner publishes agent_roster', async () => {
 const db = makeDb();
 db.state.policy = [{ event_type: 'agent_roster', level: 'public', detail: 'category' }];
 __test.setTestDb(db);
 await withServer(async (base) => {
  const body = await (await fetch(`${base}/backend/public/workspaces/${PUBLIC_WS}`)).json();
  assert.equal(body.roster, true);
  assert.deepEqual(body.agents.map((agent) => agent.name), ['Scout']);
  assert.deepEqual(body.counts, { agents: 1, busy: 0, idle: 1, disconnected: 0 });
  for (const level of ['members', 'private']) {
   db.state.policy = [{ event_type: 'agent_roster', level, detail: 'category' }];
   const hidden = await (await fetch(`${base}/backend/public/workspaces/${PUBLIC_WS}`)).json();
   assert.deepEqual(hidden.agents, [], `level ${level} does not publish the roster`);
  }
 });
});

test('publishing the roster does not open a private workspace: the same 404 as a missing one', async () => {
 const db = makeDb();
 db.state.policy = ['agent_roster', 'agent_activity', 'task_created'].map((event_type) => ({ event_type, level: 'public', detail: 'title' }));
 __test.setTestDb(db);
 await withServer(async (base) => {
  for (const suffix of ['', '/events', '/stream']) {
   const privateAnswer = await snapshot(await fetch(`${base}/backend/public/workspaces/${PRIVATE_WS}${suffix}`));
   const missingAnswer = await snapshot(await fetch(`${base}/backend/public/workspaces/${MISSING_WS}${suffix}`));
   assert.equal(privateAnswer.status, 404);
   assert.deepEqual(missingAnswer, privateAnswer, `private vs missing on ${suffix || 'summary'}`);
   assert.equal(privateAnswer.body.includes('Scout'), false);
  }
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

test('a generic /backend/db write cannot set workspaces.visibility', async () => {
 const out = stripPrivilegedDbValues('workspaces', { name: 'Renamed', visibility: 'public' });
 assert.deepEqual(out, { name: 'Renamed' });

 // And at the door: the generic update and insert routes, through the app.
 const db = makeDb();
 const writes = [];
 const unsafe = db.unsafe.bind(db);
 db.unsafe = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  if (/^(update|insert into) "?workspaces"?/.test(q)) {
   writes.push({ q, params });
   return [{ id: PRIVATE_WS, name: 'Renamed' }];
  }
  return unsafe(sql, params);
 };
 __test.setTestDb(db);
 const token = await __test.issueToken(USER, '1');
 await withServer(async (base) => {
  const update = await call(base, 'POST', '/backend/db/update', token, {
   table: 'workspaces', filters: [{ column: 'id', operator: 'eq', value: PRIVATE_WS }],
   values: { name: 'Renamed', visibility: 'public' },
  });
  assert.equal(update.status, 200, await update.text());
  const insert = await call(base, 'POST', '/backend/db/insert', token, {
   table: 'workspaces', values: { name: 'New', visibility: 'public' },
  });
  assert.equal(insert.status, 200, await insert.text());
 });
 assert.ok(writes.length >= 2, `expected both writes to reach SQL, saw ${writes.length}`);
 for (const write of writes) {
  assert.equal(write.q.includes('visibility'), false, write.q);
  assert.equal(write.params.includes('public'), false);
 }
 assert.equal(db.state.visibility[PRIVATE_WS], 'private');
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

test('two first viewers share one room, and the last one out stops its timers', async () => {
 const { createPublicStreamHub } = require('../server/public-workspace-routes.cjs');
 const timers = new Set();
 let release;
 const gate = new Promise((resolve) => { release = resolve; });
 const reader = {
  async dbNow() { await gate; return '2026-11-25T00:00:00.000000Z'; },
 };
 const hub = createPublicStreamHub({
  reader,
  setTimer: (fn) => { const id = { fn }; timers.add(id); return id; },
  clearTimer: (id) => timers.delete(id),
 });
 const workspace = { id: PUBLIC_WS };
 const summary = { agents: [] };
 const res = () => ({ write() {}, end() {} });
 const first = hub.join({ workspace, policy: new Map(), summary, res: res(), reservation: hub.reserve('1') });
 const second = hub.join({ workspace, policy: new Map(), summary, res: res(), reservation: hub.reserve('2') });
 release();
 const [leaveFirst, leaveSecond] = await Promise.all([first, second]);
 assert.equal(hub.rooms.size, 1);
 assert.equal(hub.rooms.get(PUBLIC_WS).clients.size, 2);
 assert.equal(timers.size, 2, 'one poll timer and one ping timer');
 leaveFirst();
 assert.equal(hub.rooms.size, 1);
 leaveSecond();
 leaveSecond();
 assert.equal(hub.rooms.size, 0);
 assert.equal(timers.size, 0);
});

test('stream slots are taken synchronously and given back exactly once', () => {
 const { createPublicStreamHub } = require('../server/public-workspace-routes.cjs');
 const hub = createPublicStreamHub({ reader: {} });
 const held = [];
 for (let i = 0; i < 4; i += 1) held.push(hub.reserve('9.9.9.9'));
 assert.ok(held.every(Boolean));
 assert.equal(hub.reserve('9.9.9.9'), null, 'a fifth stream from one address is refused');
 held[0].release();
 held[0].release();
 assert.ok(hub.reserve('9.9.9.9'), 'one released slot is one slot');
 assert.equal(hub.reserve('9.9.9.9'), null);
});

test('publishing a new type re-seeds the stream cursor instead of replaying its backlog', async () => {
 const { createPublicStreamHub } = require('../server/public-workspace-routes.cjs');
 const sent = [];
 let policy = new Map();
 let eventsCalls = 0;
 const reader = {
  async dbNow() { return 'NOW'; },
  async loadPublicWorkspace() { return { id: PUBLIC_WS }; },
  async loadPolicy() { return policy; },
  async eventsFor() { eventsCalls += 1; return { events: [{ id: 'old', at: 'x', type: 'task_created', category: 'tasks' }], next: 'NEXT' }; },
  async summaryFor() { return { agents: [] }; },
 };
 const hub = createPublicStreamHub({ reader, setTimer: () => ({}), clearTimer: () => {} });
 await hub.join({
  workspace: { id: PUBLIC_WS }, policy, summary: { agents: [] },
  res: { write: (chunk) => sent.push(chunk), end() {} }, reservation: hub.reserve('1'),
 });
 policy = new Map([['task_created', { level: 'public', detail: 'title' }]]);
 await hub.tick(PUBLIC_WS);
 assert.equal(eventsCalls, 0, 'the tick that sees the new type only re-seeds');
 assert.equal(hub.rooms.get(PUBLIC_WS).cursor, 'NOW');
 assert.equal(sent.some((chunk) => chunk.includes('"old"')), false);
 await hub.tick(PUBLIC_WS);
 assert.equal(eventsCalls, 1, 'the next tick reads from the new cursor');
 hub.reset();
});

function streamHubOver(db, workspaceId = PUBLIC_WS) {
 const { createPublicStreamHub } = require('../server/public-workspace-routes.cjs');
 const { createPublicWorkspaceReader } = require('../shared/public-workspace.cjs');
 const reader = createPublicWorkspaceReader({ db: (sql, params) => db.unsafe(sql, params) });
 const hub = createPublicStreamHub({ reader, setTimer: () => ({}), clearTimer: () => {} });
 const frames = [];
 async function open() {
  const workspace = await reader.loadPublicWorkspace(workspaceId);
  const policy = await reader.loadPolicy(workspace.id);
  const summary = await reader.summaryFor(workspace, policy);
  frames.push(`event: snapshot\ndata: ${JSON.stringify(summary)}\n\n`);
  await hub.join({ workspace, policy, summary, res: { write: (chunk) => frames.push(chunk), end() {} }, reservation: hub.reserve('1') });
 }
 const parsed = () => frames.map((chunk) => {
  const [eventLine, dataLine] = chunk.trim().split('\n');
  return { event: eventLine.slice('event: '.length), data: JSON.parse(dataLine.slice('data: '.length)) };
 });
 return { hub, frames, open, parsed, tick: () => hub.tick(workspaceId) };
}

test('stream: with no roster row the snapshot has no agents and no agent frame is ever sent', async () => {
 const db = makeDb();
 db.state.connectionStatus = 'online';
 const unsafe = db.unsafe.bind(db);
 db.unsafe = async (sql, params) => {
  if (String(sql).replace(/\s+/g, ' ').trim().toLowerCase().startsWith('select agent_id, status, capabilities')) {
   return [{ agent_id: AGENT, status: db.state.connectionStatus, share_policy: null }];
  }
  return unsafe(sql, params);
 };
 // Every EVENT type published, but no agent_roster row.
 db.state.policy = ['agent_activity', 'task_created', 'agent_connected'].map((event_type) => ({ event_type, level: 'public', detail: 'title' }));
 const stream = streamHubOver(db);
 await stream.open();
 db.state.connectionStatus = 'busy';
 await stream.tick();
 await stream.tick();
 const frames = stream.parsed();
 assert.equal(frames[0].event, 'snapshot');
 assert.deepEqual(frames[0].data.agents, []);
 assert.equal(frames[0].data.roster, false);
 assert.equal(frames.some((frame) => frame.event === 'agent'), false, 'no agent frame without the roster');
 assert.equal(stream.frames.join('').includes('Scout'), false);

 // The owner publishes the roster: viewers get a snapshot WITH agents, then frames.
 db.state.policy.push({ event_type: 'agent_roster', level: 'public', detail: 'category' });
 await stream.tick();
 let after = stream.parsed().slice(frames.length);
 assert.equal(after[0].event, 'snapshot');
 assert.equal(after[0].data.roster, true);
 assert.deepEqual(after[0].data.agents.map((agent) => agent.name), ['Scout']);
 db.state.connectionStatus = 'online';
 await stream.tick();
 after = stream.parsed().slice(frames.length);
 assert.ok(after.some((frame) => frame.event === 'agent' && frame.data.status === 'idle'), 'roster on: agent frames flow');

 // And withdraws it: a snapshot without agents, and no more agent frames.
 const before = stream.frames.length;
 db.state.policy = db.state.policy.filter((row) => row.event_type !== 'agent_roster');
 await stream.tick();
 db.state.connectionStatus = 'busy';
 await stream.tick();
 const withdrawn = stream.parsed().slice(before);
 assert.equal(withdrawn[0].event, 'snapshot');
 assert.deepEqual(withdrawn[0].data.agents, []);
 assert.equal(withdrawn.some((frame) => frame.event === 'agent'), false);
 stream.hub.reset();
});
