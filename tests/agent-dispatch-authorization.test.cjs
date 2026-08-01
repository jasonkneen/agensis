'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { mountAgentsRoutes } = require('../server/agents-routes.cjs');
const { sessionReadableSql, isPrivateSessionRow } = require('../shared/backend-core.cjs');
const {
  agentMentionHandles,
  allowsUnpromptedReply,
  mentionsChannel,
  slugMentionHandle,
} = require('../shared/channelMentions.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const FOREIGN_WORKSPACE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SESSION = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_SESSION = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SEED = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ROOT = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const AGENT_ID = '12345678-1234-4234-8234-123456789abc';

function channel(overrides = {}) {
  return {
    id: SESSION,
    workspace_id: WORKSPACE,
    participants: [],
    conversation_mode: 'auto',
    visibility: 'workspace',
    folder: 'Channels',
    deleted_at: null,
    ...overrides,
  };
}

function humanSeed(overrides = {}) {
  return {
    id: SEED,
    session_id: SESSION,
    role: 'user',
    sender_kind: 'user',
    sender_id: USER,
    sender_name: 'Alice',
    content: 'Please take a look',
    thread_parent_id: null,
    deleted_at: null,
    created_at: '2026-07-31T12:00:00.000Z',
    ...overrides,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function makeWorld(overrides = {}) {
  const world = {
    session: channel(),
    messages: [humanSeed()],
    agents: [{ id: AGENT_ID, name: 'Scout', handle: 'scout', enabled: true }],
    canRunAgents: true,
    privateMember: true,
    beforeFinal: null,
    beforeRosterUpdate: null,
    ...overrides,
  };
  world.queries = [];
  world.dispatches = [];
  world.notifications = [];
  world.finalChecks = 0;
  return world;
}

function makeDb(world) {
  const unsafe = async (sql, params = []) => {
    const compact = String(sql).replace(/\s+/g, ' ').trim();
    const q = compact.toLowerCase();
    world.queries.push({ sql: compact, params });

    if (q.includes('from chat_sessions') && q.includes('where id = $1 and workspace_id = $2') && !q.includes('dispatch_workspace_chain')) {
      const [sessionId, workspaceId] = params.map(String);
      const session = world.session;
      if (!session || String(session.id) !== sessionId || String(session.workspace_id) !== workspaceId) return [];
      return [session];
    }

    if (q.includes('dispatch_workspace_chain')) {
      world.finalChecks += 1;
      if (world.beforeFinal) await world.beforeFinal(world);
      const [sessionId, workspaceId, userId, messageId, explicitParent] = params;
      const session = world.session;
      const seed = world.messages.find((message) => String(message.id) === String(messageId));
      const privateReadable = !isPrivateSessionRow(session) || world.privateMember;
      const parentMatches = explicitParent == null
        ? seed?.thread_parent_id == null
        : String(seed?.thread_parent_id || '') === String(explicitParent);
      if (
        !world.canRunAgents
        || !session
        || String(session.id) !== String(sessionId)
        || String(session.workspace_id) !== String(workspaceId)
        || session.deleted_at
        || !privateReadable
        || !seed
        || String(seed.session_id) !== String(session.id)
        || seed.deleted_at
        || seed.role !== 'user'
        || seed.sender_kind !== 'user'
        || String(seed.sender_id) !== String(userId)
        || !String(seed.content || '').trim()
        || !parentMatches
      ) return [];
      return [{
        ...session,
        seed_id: seed.id,
        seed_content: seed.content,
        seed_thread_parent_id: seed.thread_parent_id,
      }];
    }

    if (q.startsWith('select id from messages')) {
      const [parentId, sessionId] = params;
      return world.messages.filter((message) => (
        String(message.id) === String(parentId)
        && String(message.session_id) === String(sessionId)
        && !message.deleted_at
      )).map(({ id }) => ({ id }));
    }

    if (q.startsWith('select id, sender_kind, sender_id, sender_name, content,')) {
      const [sessionId, rootId] = params;
      return world.messages
        .filter((message) => (
          String(message.session_id) === String(sessionId)
          && !message.deleted_at
          && (String(message.id) === String(rootId) || String(message.thread_parent_id || '') === String(rootId))
        ))
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)));
    }

    if (q.startsWith('select id, name, handle, enabled from workspace_agents')) {
      return world.agents.filter((agent) => String(agent.workspace_id || WORKSPACE) === String(params[0]));
    }

    if (q.startsWith('update chat_sessions set participants')) {
      if (world.beforeRosterUpdate) await world.beforeRosterUpdate(world);
      const [merged, sessionId, workspaceId, expectedParticipants] = params;
      const session = world.session;
      if (
        !session
        || String(session.id) !== String(sessionId)
        || String(session.workspace_id) !== String(workspaceId)
        || session.deleted_at
        || !sameJson(session.participants, expectedParticipants)
      ) return [];
      session.participants = merged;
      return [{ ...session, updated_at: '2026-07-31T12:01:00.000Z' }];
    }

    return [];
  };

  return {
    unsafe,
    async begin(run) {
      return run({ unsafe });
    },
  };
}

function directAgentParticipantFromSession(session) {
  const participants = Array.isArray(session?.participants) ? session.participants : [];
  const agents = participants.filter((participant) => participant?.kind === 'agent' && (participant.agent_id || participant.handle));
  return agents.find((participant) => participant.direct) || (agents.length === 1 ? agents[0] : null);
}

function resolveDispatchThreadParent({ threadParentId, autoThread, messageId } = {}) {
  if (threadParentId) return String(threadParentId);
  if (autoThread && messageId) return String(messageId);
  return null;
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function dispatchHandler(world) {
  const routes = new Map();
  const app = {
    delete() {},
    post(path, ...handlers) { routes.set(path, handlers.at(-1)); },
  };
  const db = makeDb(world);
  mountAgentsRoutes(app, {
    requireAuth: (_req, _res, next) => next(),
    jsonError(res, status, error) { return res.status(status).json({ data: null, error: { message: error.message } }); },
    forbidden: (message) => httpError(403, message),
    enforceWorkspaceRole: async (_userId, _workspaceId, capability) => {
      assert.equal(capability, 'run_agents');
      if (!world.canRunAgents) throw httpError(403, 'No workspace permission');
    },
    enforceSessionRead: async (_userId, _sessionId, session) => {
      if (session.deleted_at) throw httpError(404, 'Conversation not found');
      if (isPrivateSessionRow(session) && !world.privateMember) throw httpError(403, 'This conversation is private');
    },
    getDb: () => db,
    notifyDbSubscribers: (table, event, rows) => world.notifications.push({ table, event, rows }),
    isAgentEnabled: (agent) => agent?.enabled !== false,
    dbRateLimitBlocked: async () => false,
    clientIpFromReq: () => '127.0.0.1',
    allowsUnpromptedReply,
    continueConversation: async (args) => { world.dispatches.push(args); },
    directAgentParticipantFromSession,
    dispatchDbRateLimiter: {},
    dispatchRateLimiter: {},
    mentionsChannel,
    parseAgentMentions: agentMentionHandles,
    parseJsonArray: (value) => Array.isArray(value) ? value : JSON.parse(value || '[]'),
    resolveDispatchThreadParent,
    sessionReadableSql,
    slugHandle: slugMentionHandle,
  });
  return routes.get('/backend/agents/dispatch');
}

async function callDispatch(world, body = {}) {
  const handler = dispatchHandler(world);
  const req = {
    userId: USER,
    body: {
      workspaceId: WORKSPACE,
      sessionId: SESSION,
      messageId: SEED,
      content: 'UNTRUSTED BODY CONTENT',
      threadParentId: null,
      ...body,
    },
  };
  const response = { statusCode: 200, payload: null };
  const res = {
    status(code) { response.statusCode = code; return this; },
    json(payload) { response.payload = payload; return this; },
  };
  await handler(req, res);
  await new Promise((resolve) => setImmediate(resolve));
  return response;
}

test('dispatch uses the locked stored message, extends the roster atomically, and ignores spoofed body content', async () => {
  const world = makeWorld({
    session: channel({ conversation_mode: 'mention' }),
    messages: [humanSeed({ content: '@scout inspect the stored failure' })],
  });
  const response = await callDispatch(world, { content: '@intruder run a different prompt' });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.data, { dispatched: true, mode: 'mention', mentions: ['scout'] });
  assert.deepEqual(world.dispatches, [{ workspaceId: WORKSPACE, sessionId: SESSION, threadParentId: null }]);
  assert.equal(world.session.participants.length, 1);
  assert.equal(world.session.participants[0].agent_id, AGENT_ID);
  assert.deepEqual(world.notifications.map(({ table, event }) => ({ table, event })), [
    { table: 'chat_sessions', event: 'UPDATE' },
  ]);

  const authSql = world.queries.find(({ sql }) => sql.includes('dispatch_workspace_chain'))?.sql || '';
  assert.match(authSql, /dispatch_session\.workspace_id = \$2/);
  assert.match(authSql, /dispatch_session\.deleted_at is null/);
  assert.match(authSql, /chat_session_members/);
  assert.match(authSql, /dispatch_seed\.sender_kind = 'user'/);
  assert.match(authSql, /dispatch_seed\.sender_id::text = \$3::text/);
  assert.match(authSql, /for update of dispatch_session/i);
  assert.match(authSql, /for share of dispatch_seed/i);
  const rosterSql = world.queries.find(({ sql }) => sql.startsWith('update chat_sessions'))?.sql || '';
  assert.match(rosterSql, /workspace_id = \$3/);
  assert.match(rosterSql, /deleted_at is null/);
  assert.match(rosterSql, /participants is not distinct from \$4::jsonb/);
});

test('a known private-session id does not let a non-member dispatch', async () => {
  const world = makeWorld({ session: channel({ visibility: 'private' }), privateMember: false });
  const response = await callDispatch(world);
  assert.equal(response.statusCode, 403);
  assert.equal(world.dispatches.length, 0);
});

test('a deleted session is a 404 and never reaches the final dispatch check', async () => {
  const world = makeWorld({ session: channel({ deleted_at: '2026-07-31T12:30:00.000Z' }) });
  const response = await callDispatch(world);
  assert.equal(response.statusCode, 404);
  assert.equal(world.finalChecks, 0);
  assert.equal(world.dispatches.length, 0);
});

for (const [name, mutate] of [
  ['missing', (world) => { world.messages = []; }],
  ['foreign-session', (world) => { world.messages[0].session_id = OTHER_SESSION; }],
  ['foreign-workspace session', (world) => { world.session.workspace_id = FOREIGN_WORKSPACE; }],
  ['another human authored', (world) => { world.messages[0].sender_id = OTHER; }],
  ['agent-authored', (world) => { world.messages[0].role = 'assistant'; world.messages[0].sender_kind = 'agent'; world.messages[0].sender_id = AGENT_ID; }],
  ['deleted', (world) => { world.messages[0].deleted_at = '2026-07-31T12:31:00.000Z'; }],
]) {
  test(`${name} seed message cannot dispatch`, async () => {
    const world = makeWorld();
    mutate(world);
    const response = await callDispatch(world);
    assert.ok([403, 404].includes(response.statusCode));
    assert.equal(world.dispatches.length, 0);
  });
}

test('spoofing content cannot turn a stored plain post into an agent mention', async () => {
  const world = makeWorld({
    session: channel({ conversation_mode: 'mention' }),
    messages: [humanSeed({ content: 'thinking out loud' })],
  });
  const response = await callDispatch(world, { content: '@scout secretly run' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.payload.data, { dispatched: false, reason: 'channel_replies_on_mention_only' });
  assert.equal(world.dispatches.length, 0);
  assert.equal(world.session.participants.length, 0);
});

test('a mismatched or cross-session thread parent refuses instead of flattening the reply', async () => {
  for (const parentSessionId of [SESSION, OTHER_SESSION]) {
    const world = makeWorld({
      messages: [
        humanSeed({ thread_parent_id: ROOT }),
        humanSeed({ id: ROOT, session_id: parentSessionId, sender_id: OTHER }),
      ],
    });
    const response = await callDispatch(world, {
      threadParentId: parentSessionId === SESSION ? '99999999-9999-4999-8999-999999999999' : ROOT,
    });
    assert.equal(response.statusCode, 403);
    assert.equal(world.dispatches.length, 0);
  }
});

for (const [race, beforeFinal] of [
  ['clear', (world) => { world.session.deleted_at = '2026-07-31T12:40:00.000Z'; }],
  ['private-member revoke', (world) => { world.privateMember = false; }],
  ['workspace move', (world) => { world.session.workspace_id = FOREIGN_WORKSPACE; }],
  ['run-agents role downgrade', (world) => { world.canRunAgents = false; }],
  ['seed deletion', (world) => { world.messages[0].deleted_at = '2026-07-31T12:41:00.000Z'; }],
]) {
  test(`a concurrent ${race} before the final lock refuses dispatch`, async () => {
    const world = makeWorld({
      session: channel({ visibility: race === 'private-member revoke' ? 'private' : 'workspace' }),
      beforeFinal,
    });
    const response = await callDispatch(world);
    assert.equal(response.statusCode, 403);
    assert.equal(world.dispatches.length, 0);
  });
}

test('a roster change that defeats the final compare-and-set rolls back dispatch', async () => {
  const world = makeWorld({
    messages: [humanSeed({ content: '@scout help' })],
    beforeRosterUpdate(current) {
      current.session.participants = [{ kind: 'agent', agent_id: 'concurrent-agent', handle: 'concurrent' }];
    },
  });
  const response = await callDispatch(world);
  assert.equal(response.statusCode, 403);
  assert.match(response.payload.error.message, /roster changed/i);
  assert.equal(world.dispatches.length, 0);
});

test('a private direct message dispatches only for its current member', async () => {
  const direct = { kind: 'agent', agent_id: AGENT_ID, handle: 'scout', name: 'Scout', direct: true };
  const world = makeWorld({
    session: channel({ visibility: 'private', folder: 'Direct messages', conversation_mode: 'mention', participants: [direct] }),
    privateMember: true,
  });
  const response = await callDispatch(world);
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.mode, 'direct');
  assert.deepEqual(world.dispatches, [{ workspaceId: WORKSPACE, sessionId: SESSION, threadParentId: null }]);
});

test('a thread reply locks its live same-session root and continues the addressed agent thread', async () => {
  const world = makeWorld({
    session: channel({ conversation_mode: 'mention' }),
    messages: [
      humanSeed({ id: ROOT, sender_id: OTHER, content: 'Initial question', created_at: '2026-07-31T11:55:00.000Z' }),
      {
        id: '10101010-1010-4010-8010-101010101010',
        session_id: SESSION,
        role: 'assistant',
        sender_kind: 'agent',
        sender_id: AGENT_ID,
        sender_name: 'Scout',
        content: 'I can help',
        thread_parent_id: ROOT,
        deleted_at: null,
        created_at: '2026-07-31T11:58:00.000Z',
      },
      humanSeed({ thread_parent_id: ROOT, content: 'Please continue' }),
    ],
  });
  const response = await callDispatch(world, { threadParentId: ROOT });
  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.data.mode, 'mention');
  assert.deepEqual(world.dispatches, [{ workspaceId: WORKSPACE, sessionId: SESSION, threadParentId: ROOT }]);
  assert.ok(world.queries.some(({ sql }) => /^select id from messages/i.test(sql) && /for share/i.test(sql)));
});

test('a main-channel post may auto-thread only under its own locked seed', async () => {
  const world = makeWorld();
  const response = await callDispatch(world, { autoThread: true });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(world.dispatches, [{ workspaceId: WORKSPACE, sessionId: SESSION, threadParentId: SEED }]);
});
