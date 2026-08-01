// ============================================================================
// tests/schedules-gateways-realtime.test.cjs
// ----------------------------------------------------------------------------
// The two client subscriptions that had never worked, end to end.
//
// src/hooks/useSchedules.ts and src/hooks/useGateways.ts have each opened a
// db_changes subscription since the day they were written, and the server
// refused both of them: authorizeRealtimeBinding calls ensureTable, ensureTable
// throws `Table not allowed: <name>` for anything outside ALLOWED_TABLES, and
// neither table was in it. The refusal comes back as an {type:'error'} frame,
// which src/lib/backendClient.ts drops on the floor — so the schedules list and
// the gateway list simply never updated, silently, through 1531 backend and 2434
// frontend passing tests.
//
// This file walks the WHOLE path with the real server code and a fake socket:
// the exact binding the hook sends -> authorizeRealtimeBinding -> a real
// notifyDbSubscribers fanout of the row shape the real routes broadcast -> the
// frame the client actually receives. Nothing here is deployed; the proof that
// the fix works is that this fails against the old ALLOWED_TABLES and passes
// against the new one.
//
// It is also the cross-tenant test. A subscription is the one place in this
// product where a client asks the server to keep sending it rows, so "who may
// subscribe" and "whose rows arrive" are two separate questions and both are
// asked below.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

// Answers only the two role queries. Anything else throws, so a path that reads
// data this test did not anticipate announces itself instead of quietly
// resolving undefined into an authorization decision.
function makeDb({
  owners = {},
  roles = {},
  sessions = {
    'session-1': { id: 'session-1', visibility: 'workspace', folder: 'Channels' },
  },
  sessionMembers = {},
  members = {},
} = {}) {
  const uuidParams = value => Array.isArray(value)
    ? value
    : String(value || '')
      .replace(/^\{|\}$/g, '')
      .split(',')
      .map(item => item.replace(/^"|"$/g, ''))
      .filter(Boolean);
  return {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      if (n.startsWith('select id, visibility, folder from chat_sessions where id = $1')) {
        const session = sessions[String(params[0])];
        return session ? [session] : [];
      }
      if (n.startsWith('select user_id from chat_session_members')) {
        return (sessionMembers[String(params[0])] || members[String(params[0])] || []).map((user_id) => ({ user_id }));
      }
      if (n.includes('with recursive chain as')) return [];
      if (n.startsWith('select id, visibility, folder from chat_sessions')) {
        return uuidParams(params[0]).map(id => sessions[id]).filter(Boolean);
      }
      if (n.startsWith('select session_id, user_id from chat_session_members')) {
        return uuidParams(params[0]).flatMap(sessionId =>
          (members[sessionId] || sessionMembers[sessionId] || []).map(user_id => ({ session_id: sessionId, user_id })));
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

const flushFanout = () => new Promise(resolve => setImmediate(resolve));

function fakeClient(userId, subscriptions = []) {
  const sent = [];
  return {
    userId,
    readyState: 1,
    subscriptions,
    sent,
    send: (str) => sent.push(JSON.parse(str)),
  };
}

// The binding shapes below are byte-identical to the hooks', not paraphrases — the
// point of this file is that what the client actually sends is accepted, so a
// drift between these and the hooks is a real regression, not a test detail.
// useSchedules.ts:53-61 and useGateways.ts:35-43.
function scheduleBinding(workspaceId) {
  return {
    channel: `agent_schedules:${workspaceId}`,
    type: 'db_changes',
    table: 'agent_schedules',
    event: '*',
    schema: 'public',
    filter: `workspace_id=eq.${workspaceId}`,
  };
}

function gatewayBinding(workspaceId) {
  return {
    channel: `gateway_configs:${workspaceId}`,
    type: 'db_changes',
    table: 'gateway_configs',
    event: '*',
    schema: 'public',
    filter: `workspace_id=eq.${workspaceId}`,
  };
}

function dbFrames(client, table) {
  return client.sent.filter((message) => message.type === 'db_changes' && message.table === table);
}

test.afterEach(() => __test.resetTestState());

// --------------------------------------------------------------------------
// Subscribe.
// --------------------------------------------------------------------------

test('a workspace member may subscribe to agent_schedules', async () => {
  // Pre-fix this rejected with `Table not allowed: agent_schedules` from
  // ensureTable, before any role check ran.
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'viewer' } }));
  await assert.doesNotReject(
    () => __test.authorizeRealtimeBinding('u1', `agent_schedules:ws-1`, scheduleBinding('ws-1')),
  );
});

test('a workspace member may subscribe to gateway_configs', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'viewer' } }));
  await assert.doesNotReject(
    () => __test.authorizeRealtimeBinding('u1', `gateway_configs:ws-1`, gatewayBinding('ws-1')),
  );
});

test('a stranger may not subscribe to either table', async () => {
  // u2 holds owner in a DIFFERENT workspace, which is the shape that matters:
  // the refusal has to come from the workspace the binding names, not from the
  // user having no roles at all.
  __test.setTestDb(makeDb({ roles: { 'ws-2:u2': 'owner' } }));
  for (const binding of [scheduleBinding('ws-1'), gatewayBinding('ws-1')]) {
    await assert.rejects(
      () => __test.authorizeRealtimeBinding('u2', binding.channel, binding),
      { status: 403, message: 'You do not have access to this workspace' },
      `${binding.table} must refuse a non-member`,
    );
  }
});

test('neither table can be subscribed to unfiltered', async () => {
  // Without the workspace_id filter there is nothing to authorize against, and
  // the row scoping has to fail closed rather than fall through to "send them
  // everything".
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'owner' } }));
  for (const table of ['agent_schedules', 'gateway_configs']) {
    await assert.rejects(
      () => __test.authorizeRealtimeBinding('u1', `${table}:all`, {
        channel: `${table}:all`, type: 'db_changes', table, event: '*', schema: 'public',
      }),
      { status: 400, message: 'A workspace filter is required for this operation' },
      `${table} must refuse an unfiltered subscription`,
    );
  }
});

// --------------------------------------------------------------------------
// Receive. Subscribing is only half of it — the fanout has to actually reach
// the socket, with the right row, and only the right socket.
// --------------------------------------------------------------------------

test('a schedule change reaches the subscriber with the full row', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'viewer' } }));
  const client = __test.registerTestWebsocketClient(fakeClient('u1', [scheduleBinding('ws-1')]));

  // The row shape POST /backend/workspaces/:id/schedules broadcasts: `returning *`.
  __test.notifyDbSubscribers('agent_schedules', 'INSERT', [{
    id: 'sched-1',
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    session_id: 'session-1',
    name: 'Daily standup',
    prompt: 'Summarise yesterday',
    interval_seconds: 86400,
    enabled: true,
    running: false,
    next_run_at: '2026-07-30T09:00:00.000Z',
  }]);
  await flushFanout();

  const frames = dbFrames(client, 'agent_schedules');
  assert.equal(frames.length, 1, 'the subscriber must receive exactly one frame');
  const payload = frames[0].payload;
  assert.equal(payload.eventType, 'INSERT');
  // useSchedules puts payload.new STRAIGHT into its list, so these are the
  // fields the row in the UI is made of. A strip added to this table would blank
  // them; the list would go live and show nothing.
  assert.equal(payload.new.id, 'sched-1');
  assert.equal(payload.new.name, 'Daily standup');
  assert.equal(payload.new.interval_seconds, 86400);
  assert.equal(payload.new.enabled, true);
});

test('a private-session schedule reaches only that session members', async () => {
  __test.setTestDb(makeDb({
    roles: { 'ws-1:u1': 'viewer', 'ws-1:u2': 'viewer' },
    sessions: {
      'dm-1': { id: 'dm-1', visibility: 'private', folder: 'Direct messages' },
    },
    sessionMembers: { 'dm-1': ['u1'] },
  }));
  const member = __test.registerTestWebsocketClient(fakeClient('u1', [scheduleBinding('ws-1')]));
  const other = __test.registerTestWebsocketClient(fakeClient('u2', [scheduleBinding('ws-1')]));

  __test.notifyDbSubscribers('agent_schedules', 'INSERT', [{
    id: 'sched-private',
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    session_id: 'dm-1',
    name: 'Private review',
    prompt: 'Summarise the confidential channel',
    interval_seconds: 86400,
    enabled: true,
  }]);
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(dbFrames(member, 'agent_schedules').length, 1);
  assert.equal(dbFrames(other, 'agent_schedules').length, 0);
});

test('a gateway change reaches the subscriber with no key and no headers', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'viewer' } }));
  const client = __test.registerTestWebsocketClient(fakeClient('u1', [gatewayBinding('ws-1')]));

  // The RAW row shape. The three dedicated routes map through publicGatewayConfig
  // first, but the generic /backend/db/update|delete routes — which allowlisting
  // the table is exactly what opened — fan out `returning *`, so this is the
  // payload the strip has to survive.
  __test.notifyDbSubscribers('gateway_configs', 'UPDATE', [{
    id: 'gw-1',
    workspace_id: 'ws-1',
    name: 'OpenRouter',
    base_url: 'https://openrouter.ai/api/v1',
    api_key_cipher: 'v1:live-encrypted-provider-key',
    model: 'deepseek/deepseek-v4-flash',
    protocol: 'openai-chat',
    headers: { Authorization: 'Bearer live-key' },
  }]);

  const frames = dbFrames(client, 'gateway_configs');
  assert.equal(frames.length, 1, 'the subscriber must receive exactly one frame');
  const row = frames[0].payload.new;
  assert.equal('api_key_cipher' in row, false, 'the encrypted provider key must not ride the socket');
  assert.equal('headers' in row, false, 'headers can hold an Authorization value and must not ride the socket');
  assert.equal(row.name, 'OpenRouter', 'the metadata the list renders must arrive');
  // Belt and braces against a future strip that takes too much: the client keys
  // its refetch off the row, and notifyDbSubscribers matches the filter against
  // workspace_id before sending.
  assert.equal(row.id, 'gw-1');
  assert.equal(row.workspace_id, 'ws-1');
});

test('one workspace never receives another workspace rows', async () => {
  // The subscribe check and the delivery filter are different code. This is the
  // second one: two authorized sockets, one row, one recipient.
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'owner', 'ws-2:u2': 'owner' } }));
  const inWorkspace = __test.registerTestWebsocketClient(
    fakeClient('u1', [scheduleBinding('ws-1'), gatewayBinding('ws-1')]),
  );
  const elsewhere = __test.registerTestWebsocketClient(
    fakeClient('u2', [scheduleBinding('ws-2'), gatewayBinding('ws-2')]),
  );

  __test.notifyDbSubscribers('agent_schedules', 'UPDATE', [{
    id: 'sched-1', workspace_id: 'ws-1', session_id: 'session-1', name: 'ours',
  }]);
  __test.notifyDbSubscribers('gateway_configs', 'UPDATE', [{ id: 'gw-1', workspace_id: 'ws-1', name: 'ours' }]);
  await flushFanout();

  assert.equal(dbFrames(inWorkspace, 'agent_schedules').length, 1);
  assert.equal(dbFrames(inWorkspace, 'gateway_configs').length, 1);
  assert.equal(elsewhere.sent.length, 0, 'a subscriber in ws-2 must receive nothing about ws-1');
});

test('a private-session schedule reaches only current session members', async () => {
  __test.setTestDb(makeDb({
    roles: { 'ws-1:member': 'viewer', 'ws-1:outsider': 'viewer' },
    sessions: {
      'private-1': { id: 'private-1', visibility: 'private', folder: 'Direct messages' },
    },
    members: { 'private-1': ['member'] },
  }));
  const member = __test.registerTestWebsocketClient(
    fakeClient('member', [scheduleBinding('ws-1')]),
  );
  const outsider = __test.registerTestWebsocketClient(
    fakeClient('outsider', [scheduleBinding('ws-1')]),
  );

  __test.notifyDbSubscribers('agent_schedules', 'UPDATE', [{
    id: 'sched-private',
    workspace_id: 'ws-1',
    session_id: 'private-1',
    name: 'Private reminder',
    prompt: 'Confidential prompt',
  }]);
  await flushFanout();

  assert.equal(dbFrames(member, 'agent_schedules').length, 1);
  assert.equal(dbFrames(outsider, 'agent_schedules').length, 0);
});

test('a member removed mid-session stops receiving schedules and gateways', async () => {
  // Subscriptions are authorized at subscribe time, so the revocation sweep is
  // what makes that safe for a long-lived socket. These two tables ride it like
  // every other one — worth pinning, because they are the newest members of
  // ALLOWED_TABLES and the sweep is easy to assume rather than check.
  __test.setTestDb(makeDb({ roles: {} })); // u1 now holds nothing anywhere
  const client = __test.registerTestWebsocketClient(
    fakeClient('u1', [scheduleBinding('ws-1'), gatewayBinding('ws-1')]),
  );

  await __test.revokeRealtimeAccessForMember('u1');

  assert.deepEqual(client.subscriptions, [], 'both subscriptions must be dropped');
  const reasons = client.sent.filter((m) => m.event === 'unsubscribed').map((m) => m.reason);
  assert.deepEqual(reasons, ['access_revoked', 'access_revoked']);
});
