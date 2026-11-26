'use strict';

// ============================================================================
// tests/public-workspace.test.cjs
// ----------------------------------------------------------------------------
// Pins the security rules of shared/public-workspace.cjs — the ONLY path from
// a workspace to the open internet. Route-level behaviour (the identical 404,
// the manage gate, the audit rows, the stream) is in
// tests/public-workspace-routes.test.cjs and tests/public-workspace-netlify.test.cjs.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const {
 PUBLIC_EVENT_TYPES,
 POLICY_EVENT_TYPES,
 publicProjection,
 publicAgent,
 publicAgentStatus,
 publicListing,
 normalizePublicPolicyEntry,
 publicPolicyMap,
 effectiveShareFlags,
 scrubPublicText,
 opaqueActorId,
 activityForTool,
 createPublicWorkspaceReader,
} = require('../shared/public-workspace.cjs');

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PRIVATE_WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MISSING_WS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AGENT = '11111111-1111-4111-8111-111111111111';
const AGENT_2 = '22222222-2222-4222-8222-222222222222';
const USER = '33333333-3333-4333-8333-333333333333';
const TASK = '44444444-4444-4444-8444-444444444444';

function policy(entries) {
 return publicPolicyMap(Object.entries(entries).map(([event_type, [level, detail]]) => ({ event_type, level, detail })));
}

function row(overrides = {}) {
 return {
  id: 'e1',
  at: '2026-11-25T10:00:00.000000Z',
  workspace_id: WS,
  event_type: 'task_created',
  entity_type: 'task',
  entity_id: TASK,
  title: 'Task created: Ship the hall',
  actor_kind: 'human',
  actor_agent_id: '',
  actor_agent_name: '',
  user_id: USER,
  user_display_name: 'Robin',
  session_open: false,
  task_visible: true,
  message_content: null,
  ...overrides,
 };
}

// --- rule 1: no policy row = nothing leaves --------------------------------

test('no policy row = nothing leaves', () => {
 for (const type of Object.keys(PUBLIC_EVENT_TYPES)) {
  const r = row({ event_type: type, session_open: true, task_visible: true });
  assert.equal(publicProjection(r, new Map(), null), null, `${type} left with an empty policy`);
  assert.equal(publicProjection(r, null, null), null, `${type} left with no policy at all`);
  // A policy for a DIFFERENT type does not publish this one.
  const other = type === 'canvas_updated' ? 'comment_created' : 'canvas_updated';
  assert.equal(publicProjection(r, policy({ [other]: ['public', 'full'] }), null), null);
 }
});

test('members and private levels never leave through the public projection', () => {
 for (const level of ['members', 'private']) {
  const p = policy({ task_created: [level, 'full'] });
  assert.equal(publicProjection(row(), p, null), null, `level ${level} leaked`);
 }
});

// --- rule 3: detail levels ---------------------------------------------------

test('detail category carries only id, at, type and category', () => {
 const event = publicProjection(row(), policy({ task_created: ['public', 'category'] }), null);
 assert.deepEqual(event, { id: 'e1', at: '2026-11-25T10:00:00.000000Z', type: 'task_created', category: 'tasks' });
});

test('detail title adds title, actor and entity, and no detail', () => {
 const event = publicProjection(row(), policy({ task_created: ['public', 'title'] }), null);
 assert.equal(event.title, 'Task created: Ship the hall');
 assert.deepEqual(event.actor, { kind: 'human', id: opaqueActorId(WS, USER), name: 'Robin' });
 assert.deepEqual(event.entity, { kind: 'task', id: TASK });
 assert.equal('detail' in event, false);
});

test('detail full adds a short plain detail from the one named source, capped at 280', () => {
 const long = 'word '.repeat(200);
 const r = row({ event_type: 'message_sent', entity_type: 'message', session_open: true, message_content: long, title: 'Robin: hello' });
 const event = publicProjection(r, policy({ message_sent: ['public', 'full'] }), null);
 assert.ok(event.detail.length <= 280);
 // A type without a named detail source carries no detail at 'full'.
 const task = publicProjection(row({ message_content: 'should not appear' }), policy({ task_created: ['public', 'full'] }), null);
 assert.equal('detail' in task, false);
});

test('memory_added never rises above category (its title IS the memory)', () => {
 const r = row({ event_type: 'memory_added', entity_type: 'memory', entity_id: null, title: 'Memory added: the vault code is 1234' });
 const event = publicProjection(r, policy({ memory_added: ['public', 'full'] }), null);
 assert.deepEqual(Object.keys(event).sort(), ['at', 'category', 'id', 'type']);
 assert.equal(JSON.stringify(event).includes('vault'), false);
});

// --- rule 4: never leaves ------------------------------------------------------

test('private-session events never leave, and an unresolved session fails closed', () => {
 const p = policy({ message_sent: ['public', 'full'], chat_created: ['public', 'title'] });
 for (const type of ['message_sent', 'chat_created']) {
  for (const sessionOpen of [false, null, undefined, 'true', 1]) {
   const r = row({ event_type: type, session_open: sessionOpen, message_content: 'DM-BODY-SENTINEL', title: 'DM-TITLE-SENTINEL' });
   assert.equal(publicProjection(r, p, null), null, `${type} left with session_open=${String(sessionOpen)}`);
  }
 }
});

test('tasks in a private project (or unresolved tasks) never leave', () => {
 const p = policy({ task_created: ['public', 'title'], task_completed: ['public', 'title'], task_updated: ['public', 'title'] });
 for (const type of ['task_created', 'task_completed', 'task_updated']) {
  for (const visible of [false, null, undefined]) {
   assert.equal(publicProjection(row({ event_type: type, task_visible: visible }), p, null), null);
  }
 }
});

test('every never-leaves pattern drops the whole field, never a substring', () => {
 const cases = [
  'Contact robin@example.com about it',
  'See https://internal.example.test/doc',
  'see www.internal-wiki.test/page',
  'Edited /srv/host-a/projects/secret/app.ts',
  'Read ~/notes.txt',
  'Opened C:\\Users\\robin\\file.txt',
  'Changed src/App.tsx today',
  'key sk-abcdefghijklmnop',
  'token agw_abcdefghijkl',
  'gh token ghp_abcdefghijklmnop',
  'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig',
  'Authorization: Bearer abcdefghijklmnop',
  'hash 0123456789abcdef0123456789abcdef',
  'blob ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123',
 ];
 for (const text of cases) {
  assert.equal(scrubPublicText(text, 160), '', `kept: ${text}`);
  const event = publicProjection(row({ title: text }), policy({ task_created: ['public', 'title'] }), null);
  assert.ok(event, 'the event still leaves');
  assert.equal('title' in event, false, `title kept: ${text}`);
 }
 // Ordinary text passes, and an agent handle is not an email.
 assert.equal(scrubPublicText('@claude connected', 160), '@claude connected');
 assert.equal(scrubPublicText('Task created: Q1/Q2 plan', 160), 'Task created: Q1/Q2 plan');
});

test('event types outside the publishable set never leave, and the validator refuses them', () => {
 for (const type of ['provider_call', 'join_link_created', 'join_link_redeemed', 'audit', 'anything']) {
  const r = row({ event_type: type });
  assert.equal(publicProjection(r, { [type]: { level: 'public', detail: 'full' } }, null), null);
  assert.equal(normalizePublicPolicyEntry({ eventType: type, level: 'public', detail: 'full' }).ok, false);
 }
});

test('the policy validator refuses unknown levels and details, naming the field', () => {
 const badLevel = normalizePublicPolicyEntry({ eventType: 'task_created', level: 'everyone', detail: 'title' });
 assert.equal(badLevel.ok, false);
 assert.match(badLevel.errors.join(' '), /level/);
 const badDetail = normalizePublicPolicyEntry({ eventType: 'task_created', level: 'public', detail: 'everything' });
 assert.equal(badDetail.ok, false);
 assert.match(badDetail.errors.join(' '), /detail/);
 assert.equal(normalizePublicPolicyEntry({ eventType: 'agent_activity', level: 'public', detail: 'category' }).ok, true);
 assert.ok(POLICY_EVENT_TYPES.includes('agent_activity'));
});

test('a human actor carries a display name and an opaque id only — no email, no user id', () => {
 const event = publicProjection(
  row({ user_display_name: 'robin@example.com' }),
  policy({ task_created: ['public', 'title'] }),
  null,
 );
 assert.equal(event.actor.name, 'Someone');
 assert.notEqual(event.actor.id, USER);
 assert.equal(JSON.stringify(event).includes(USER), false);
 assert.equal(JSON.stringify(event).includes('@example.com'), false);
});

// --- rule 2: the AND with the agent's share policy ---------------------------

test('effective = workspace policy AND the agent share policy; neither widens the other', () => {
 const p = policy({ document_created: ['public', 'title'], memory_added: ['public', 'category'] });
 const doc = row({ event_type: 'document_created', entity_type: 'document', actor_kind: 'agent', actor_agent_id: AGENT, actor_agent_name: 'Scout', user_id: null });
 const all = { memory: true, skills: true, tools: true, documents: true };
 assert.ok(publicProjection(doc, p, all), 'both sides on: leaves');
 assert.equal(publicProjection(doc, p, { ...all, documents: false }), null, 'agent withholds documents');
 assert.equal(publicProjection(doc, p, null), null, 'agent with unknown flags: fails closed');
 assert.equal(publicProjection(doc, new Map(), all), null, 'agent shares but the workspace does not publish');

 const flags = effectiveShareFlags(
  { id: AGENT, sharing: { documents: true } },
  [{ agent_id: AGENT, status: 'online', share_policy: { channels: { documents: false } } }],
 );
 assert.equal(flags.documents, false, 'a machine withhold beats the workspace switch');
 const flagsOff = effectiveShareFlags({ id: AGENT, sharing: { documents: false } }, [{ agent_id: AGENT, status: 'online', share_policy: { channels: { documents: true } } }]);
 assert.equal(flagsOff.documents, false, 'a machine share cannot widen the workspace switch');
});

// --- agents, status and listings ----------------------------------------------

test('public agent carries named fields only', () => {
 const agentRow = {
  id: AGENT, name: 'Scout', avatar: 'SC', accent_color: '#ff7a59', run_mode: 'daemon', enabled: true,
  system_prompt: 'PROMPT-SENTINEL', soul: 'SOUL-SENTINEL', instructions: 'INSTR-SENTINEL',
  metadata: { host_folders: ['/srv/host-a/secret'] }, connect_token_hash: 'TOKEN-SENTINEL', handle: 'scout',
 };
 const agent = publicAgent(agentRow, [{ agent_id: AGENT, status: 'busy', capabilities: { clis: ['x'] } }], 'edit');
 assert.deepEqual(Object.keys(agent).sort(), ['accentColor', 'activity', 'avatar', 'id', 'name', 'runMode', 'status']);
 assert.equal(agent.status, 'busy');
 assert.equal(agent.activity, 'edit');
 const json = JSON.stringify(agent);
 for (const sentinel of ['PROMPT', 'SOUL', 'INSTR', 'TOKEN', '/srv/host-a']) assert.equal(json.includes(sentinel), false);
 // An avatar that looks like a URL or path is never echoed.
 assert.equal(publicAgent({ ...agentRow, avatar: 'https://x.test/a.png' }).avatar, 'SC');
 // Activity is dropped unless the agent is busy.
 assert.equal('activity' in publicAgent(agentRow, [], 'edit'), false);
});

test('status follows the network map rule', () => {
 const cases = [
  [{ id: AGENT, run_mode: 'builtin', enabled: false }, [], 'inactive'],
  [{ id: AGENT, run_mode: 'builtin' }, [], 'idle'],
  [{ id: AGENT, run_mode: 'daemon' }, [], 'disconnected'],
  [{ id: AGENT, run_mode: 'daemon' }, [{ agent_id: AGENT, status: 'offline' }], 'disconnected'],
  [{ id: AGENT, run_mode: 'daemon' }, [{ agent_id: AGENT, status: 'online' }], 'idle'],
  [{ id: AGENT, run_mode: 'sandbox' }, [{ agent_id: AGENT, status: 'online' }, { agent_id: AGENT, status: 'busy' }], 'busy'],
  [{ id: AGENT, run_mode: 'external' }, [{ agent_id: AGENT_2, status: 'busy' }], 'disconnected'],
 ];
 for (const [agentRow, connections, expected] of cases) {
  assert.equal(publicAgentStatus(agentRow, connections), expected, JSON.stringify({ agentRow, connections }));
 }
});

test('activity comes from the tool NAME through an exact closed map', () => {
 assert.equal(activityForTool('Read'), 'read');
 assert.equal(activityForTool('Grep'), 'search');
 assert.equal(activityForTool('Edit'), 'edit');
 assert.equal(activityForTool('Bash'), 'run');
 assert.equal(activityForTool('Bash · rm -rf /'), null, 'a name carrying arguments is not a match');
 assert.equal(activityForTool('mcp__agensis__post_message'), null);
 assert.equal(activityForTool(''), null);
});

test('listing projection drops the template body, publisher id and fingerprint', () => {
 const listing = publicListing({
  id: 'l1', slug: 'scout', listing_type: 'template', name: 'Scout', category: 'Research',
  description: 'Finds things', capabilities: ['search'], purpose: 'collaborator', resource_facets: [],
  avatar: 'SC', accent_color: '#ff7a59', status: 'published', publisher_workspace_id: 'PUBLISHER-SENTINEL',
  install_count: 3, hire_count: 1, fingerprint: 'FINGERPRINT-SENTINEL',
  system_prompt: 'PROMPT-SENTINEL', soul: 'SOUL-SENTINEL', instructions: 'INSTR-SENTINEL',
  tools: ['TOOLS-SENTINEL'], skills: ['SKILLS-SENTINEL'],
 });
 assert.deepEqual(Object.keys(listing).sort(), [
  'accentColor', 'avatar', 'capabilities', 'category', 'description', 'hireCount', 'id', 'installCount',
  'name', 'purpose', 'resourceFacets', 'slug', 'type',
 ]);
 const json = JSON.stringify(listing);
 for (const sentinel of ['PUBLISHER', 'FINGERPRINT', 'PROMPT', 'SOUL', 'INSTR', 'TOOLS', 'SKILLS']) {
  assert.equal(json.includes(sentinel), false, `${sentinel} leaked`);
 }
});

// --- the reader, over a fake db -------------------------------------------------

function fakeDb(state) {
 const calls = [];
 const db = async (sql, params = []) => {
  const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  calls.push({ q, params });
  if (q.startsWith('select id, name, description, icon, visibility from workspaces')) {
   return state.workspaces.filter((w) => w.id === params[0]);
  }
  if (q.startsWith('select event_type, level, detail from workspace_public_policy')) return state.policy[params[0]] || [];
  if (q.startsWith('select id, name, avatar, accent_color, run_mode, enabled, sharing from workspace_agents')) return state.agents;
  if (q.startsWith('select agent_id, status, capabilities')) return state.connections;
  if (q.startsWith('select j.agent_id::text')) return state.jobs;
  if (q.startsWith('select e.id::text as id')) {
   const matched = state.events.filter((e) => params[1].split(',').includes(e.event_type));
   return q.includes('order by e.created_at desc') ? [...matched].reverse() : matched;
  }
  if (q.startsWith('select * from marketplace_listings')) return state.listings || [];
  throw new Error(`Unexpected SQL: ${q}`);
 };
 db.calls = calls;
 return db;
}

function baseState() {
 return {
  workspaces: [
   { id: WS, name: 'Agent Expo', description: 'The hall', icon: 'H', visibility: 'public' },
   { id: PRIVATE_WS, name: 'Private place', description: 'PRIVATE-SENTINEL', icon: 'P', visibility: 'private' },
  ],
  policy: {},
  agents: [
   { id: AGENT, name: 'Scout', avatar: 'SC', accent_color: '#ff7a59', run_mode: 'daemon', enabled: true, sharing: {} },
   { id: AGENT_2, name: 'Quiet', avatar: 'QU', accent_color: '#123456', run_mode: 'daemon', enabled: true, sharing: { tools: false } },
  ],
  connections: [
   { agent_id: AGENT, status: 'busy', share_policy: null },
   { agent_id: AGENT_2, status: 'busy', share_policy: null },
  ],
  jobs: [
   { agent_id: AGENT, tool_name: 'Edit' },
   { agent_id: AGENT_2, tool_name: 'Read' },
  ],
  events: [],
 };
}

test('reader: a private workspace and a missing one both answer null, without reading anything else', async () => {
 const db = fakeDb(baseState());
 const reader = createPublicWorkspaceReader({ db });
 for (const id of [PRIVATE_WS, MISSING_WS, 'not-a-uuid', '', "'; drop table workspaces; --"]) {
  assert.equal(await reader.getSummary(id), null, `summary for ${id}`);
  assert.equal(await reader.getEvents(id, {}), null, `events for ${id}`);
 }
 const touched = new Set(db.calls.map((call) => call.q.split(' from ')[1]?.split(' ')[0]));
 assert.deepEqual([...touched], ['workspaces'], 'only the visibility lookup ran');
 assert.equal(db.calls.some((call) => call.params.includes('not-a-uuid')), false, 'a malformed id never reaches SQL');
});

test('reader: activity needs the agent_activity policy row AND the agent sharing tools', async () => {
 const state = baseState();
 const reader = createPublicWorkspaceReader({ db: fakeDb(state) });
 let summary = await reader.getSummary(WS);
 assert.equal(summary.agents.some((agent) => 'activity' in agent), false, 'no policy row: no activity');
 state.policy[WS] = [{ event_type: 'agent_activity', level: 'public', detail: 'category' }];
 summary = await reader.getSummary(WS);
 const byId = new Map(summary.agents.map((agent) => [agent.id, agent]));
 assert.equal(byId.get(AGENT).activity, 'edit');
 assert.equal('activity' in byId.get(AGENT_2), false, 'an agent that withholds tools shows no activity');
 assert.deepEqual(summary.counts, { agents: 2, busy: 2, idle: 0, disconnected: 0 });
});

test('reader: events go through the projection — private-session content never appears', async () => {
 const state = baseState();
 state.policy[WS] = [
  { event_type: 'message_sent', level: 'public', detail: 'full' },
  { event_type: 'memory_added', level: 'public', detail: 'full' },
 ];
 state.events = [
  { id: 'e1', at: '2026-11-25T10:00:00.000001Z', workspace_id: WS, event_type: 'message_sent', entity_type: 'message', entity_id: 'm1', title: 'Robin: hello all', user_id: USER, metadata: { session_id: 's1' }, user_display_name: 'Robin', session_open: true, task_visible: null, message_content: 'hello all' },
  { id: 'e3', at: '2026-11-25T10:00:00.000003Z', workspace_id: WS, event_type: 'memory_added', entity_type: 'memory', entity_id: null, title: 'Memory added: MEMORY-SENTINEL', user_id: USER, metadata: { category: 'x' }, user_display_name: 'Robin', session_open: null, task_visible: null, message_content: null },
  { id: 'e4', at: '2026-11-25T10:00:00.000004Z', workspace_id: WS, event_type: 'provider_call', entity_type: 'agent', entity_id: AGENT, title: 'PROVIDER-SENTINEL', user_id: null, metadata: {}, user_display_name: null, session_open: null, task_visible: null, message_content: null },
  { id: 'e2', at: '2026-11-25T10:00:00.000005Z', workspace_id: WS, event_type: 'message_sent', entity_type: 'message', entity_id: 'm2', title: 'Robin: DM-TITLE-SENTINEL', user_id: USER, metadata: { session_id: 's2', content: 'DM-META-SENTINEL' }, user_display_name: 'Robin', session_open: false, task_visible: null, message_content: 'DM-BODY-SENTINEL' },
 ];
 const reader = createPublicWorkspaceReader({ db: fakeDb(state) });
 const page = await reader.getEvents(WS, {});
 assert.deepEqual(page.events.map((event) => event.id), ['e1', 'e3']);
 assert.equal(page.events[0].detail, 'hello all');
 const json = JSON.stringify(page);
 for (const sentinel of ['DM-TITLE', 'DM-META', 'DM-BODY', 'MEMORY-SENTINEL', 'PROVIDER', 's1', 's2']) {
  assert.equal(json.includes(sentinel), false, `${sentinel} leaked`);
 }
 assert.equal(page.next, '2026-11-25T10:00:00.000005Z', 'the cursor still advances past rows that did not leave');
});

test('reader: a bad since is a 400, a big limit is capped at 200', async () => {
 const state = baseState();
 state.policy[WS] = [{ event_type: 'task_created', level: 'public', detail: 'category' }];
 const db = fakeDb(state);
 const reader = createPublicWorkspaceReader({ db });
 await assert.rejects(reader.getEvents(WS, { since: 'yesterday-ish' }), (error) => error.status === 400);
 await reader.getEvents(WS, { since: '2026-11-25T00:00:00Z', limit: '100000' });
 const eventsCall = db.calls.find((call) => call.q.startsWith('select e.id::text as id'));
 assert.equal(eventsCall.params[3], 200);
});

test('reader: never selects prompts, tool arguments, hosts, folders, persona prose, documents or memory', async () => {
 const state = baseState();
 state.policy[WS] = POLICY_EVENT_TYPES.map((event_type) => ({ event_type, level: 'public', detail: 'full' }));
 const db = fakeDb(state);
 const reader = createPublicWorkspaceReader({ db });
 await reader.getSummary(WS);
 await reader.getEvents(WS, {});
 await reader.getEvents(WS, { since: '2026-11-25T00:00:00Z' });
 assert.ok(db.calls.some((call) => call.q.startsWith('select j.agent_id::text')), 'the activity query ran');
 const forbidden = [
  /\bprompt\b/, /\btool_detail\b/, /\bhost\b/, /\bcwd\b/, /\bsystem_prompt\b/, /\bsoul\b/, /\binstructions\b/,
  /\bconnect_token/, /\bhost_folders\b/, /\bemail\b/, /\bresponse\b/, /\bdocuments\b/, /\bagent_memory/,
  /\bagent_documents\b/, /\bworkspace_secrets\b/, /\bsandbox_config\b/, /\bwa\.metadata\b/, /\bcapabilities\b(?! -> 'sharepolicy')/,
 ];
 for (const call of db.calls) {
  for (const pattern of forbidden) assert.equal(pattern.test(call.q), false, `${pattern} in: ${call.q.slice(0, 160)}`);
 }
});

test('reader: a message_sent leaves only for a PLAIN message in an open session', async () => {
 // Tool steps are logged as message_sent too; their title is "<sender>: <tool> · <arguments>".
 const db = fakeDb({ ...baseState(), policy: { [WS]: [{ event_type: 'message_sent', level: 'public', detail: 'title' }] } });
 const reader = createPublicWorkspaceReader({ db });
 await reader.getEvents(WS, {});
 const sql = db.calls.find((call) => call.q.startsWith('select e.id::text as id')).q;
 const branch = sql.slice(sql.indexOf("when e.event_type = 'message_sent' then ("), sql.indexOf("when e.event_type = 'chat_created' then ("));
 assert.match(branch, /coalesce\(m\.message_kind, ''\) = ''/);
 assert.match(branch, /coalesce\(ms\.visibility, 'workspace'\) <> 'private'/);
 assert.match(branch, /coalesce\(ms\.folder, ''\) <> 'direct messages'/);
});
