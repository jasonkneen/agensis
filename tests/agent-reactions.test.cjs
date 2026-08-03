'use strict';

// ============================================================================
// tests/agent-reactions.test.cjs
// ----------------------------------------------------------------------------
// The AGENT reaction lane: the MCP tool `react_to_message`.
//
// WHY THE LANE EXISTS AT ALL
//
// `POST /backend/messages/:messageId/reactions` is `requireAuth` and binds the
// reactor from `req.userId`. An agent has a row in `workspace_agents`, not in
// `app_users`, so there was no identity for it to react as — not a permissions
// setting, an absent lane. Everything here defends the lane that fills it.
//
// WHAT A MOCKED DB CAN AND CANNOT PROVE, stated plainly (the same honesty
// tests/message-reactions.test.cjs states for the human lane).
//
// A mock has no concurrency and no row lock, so "two reactors raced and both
// survived" is NOT a claim this file makes. What it does pin is the property the
// fix turns on and that a refactor would silently destroy: the mutation is ONE
// round trip, and NOTHING reads the reactions map before it. A read-modify-write
// reintroduced here turns this file red.
//
// The authorization half is asserted STRUCTURALLY, against the statement text,
// because a mock that itself enforced the guard would only be testing the mock
// (tests/mock-db-tests-can-be-vacuous is the lesson this repo already learned).
// So: the agent statement must carry the agent predicate and must NOT carry the
// human one — an agent authorized through `chat_session_members` would be an
// agent authorized as a person.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../server/mcp.cjs');
const { __test } = require('../server/index.cjs');
const { roleHasWorkspaceCapability } = __test;
const {
  AGENT_REACTION_ADD_SQL,
  AGENT_REACTION_CURRENT_SQL,
  AGENT_REACTION_REMOVE_SQL,
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
  REACTION_ADD_SQL,
  agentReactionToggleSql,
} = require('../shared/reaction-toggle.cjs');

const WS = 'ws-1';
const OTHER_WS = 'ws-2';
const AGENT = {
  kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder',
  agent: { model: 'claude-opus-4-8', description: 'coding agent' },
};
const WORKSPACE = { kind: 'workspace', workspaceId: WS, name: 'MCP client', autoApprove: false };
const FLOW_CHANNEL = {
  kind: 'integration', connectionId: 'flow-1', workspaceId: WS, channelId: 'ch-1', name: 'Flows',
  scopes: ['channels:read', 'messages:read', 'messages:write', 'agents:read', 'agents:dispatch'],
};

// m-1 lives in ch-1 (this workspace). m-x lives in ch-x (another tenant) and is
// never reachable. m-held already carries this agent's ✅.
const MESSAGE_ROWS = {
  'm-1': { id: 'm-1', session_id: 'ch-1', workspace_id: WS, reactions: {} },
  'm-held': { id: 'm-held', session_id: 'ch-1', workspace_id: WS, reactions: { '✅': ['agent-1'] } },
  'm-x': { id: 'm-x', session_id: 'ch-x', workspace_id: OTHER_WS, reactions: {} },
};

function makeDb({ updateReturnsNothing = false } = {}) {
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params, sql: String(sql) });

      // assertChannelInWorkspace
      if (n.startsWith('select id from chat_sessions where id = $1 and workspace_id = $2')) {
        const [id, ws] = params;
        return (id === 'ch-1' && ws === WS) ? [{ id: 'ch-1' }] : [];
      }
      // The tool's pre-write resolve of the message's session.
      if (n.startsWith('select m.id, m.session_id, s.workspace_id')) {
        const [id, ws] = params;
        const row = MESSAGE_ROWS[id];
        return (row && row.workspace_id === ws)
          ? [{ id: row.id, session_id: row.session_id, workspace_id: row.workspace_id }]
          : [];
      }
      if (n.startsWith('update messages set reactions')) {
        if (updateReturnsNothing) return [];
        const [id, sessionId, reaction, actor] = params;
        const row = MESSAGE_ROWS[id];
        if (!row) return [];
        const next = JSON.parse(JSON.stringify(row.reactions || {}));
        const held = next[reaction] || [];
        if (n.includes('- $4::text')) {
          const left = held.filter((x) => x !== actor);
          if (left.length === 0) delete next[reaction];
          else next[reaction] = left;
        } else {
          next[reaction] = [...held, actor];
        }
        return [{
          id, session_id: sessionId, reactions: next,
          sender_kind: 'user', sender_id: 'user-9', sender_name: 'Jason',
          thread_parent_id: null, created_at: '2026-08-03T00:00:00.000Z',
        }];
      }
      // The no-op explanation read.
      if (n.startsWith('select id, session_id, reactions')) {
        const row = MESSAGE_ROWS[params[0]];
        return row ? [{ ...row }] : [];
      }
      return [];
    },
  };
  return db;
}

function makeDeps(overrides = {}) {
  const notifyCalls = [];
  const tokenMap = { 'agent-token': AGENT, 'ws-token': WORKSPACE, 'flow-token': FLOW_CHANNEL };
  const deps = {
    getDb: () => overrides.db,
    verifyMcpToken: async (token) => tokenMap[token] || null,
    continueConversation: async () => { },
    notifyDbSubscribers: (table, ev, rows) => { notifyCalls.push({ table, ev, rows }); },
    slugHandle: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
    claimMcpJob: async () => null,
    submitMcpJobResult: async () => ({ jobId: 'x', status: 'done' }),
    resolveWorkspaceAgentByHandle: async (_ws, handle) => {
      if (handle === 'coder') return { id: 'agent-1', handle: 'coder', name: 'Coder', mcp_approved: true };
      // Registered but never approved for the MCP control lane.
      if (handle === 'ghost') return { id: 'agent-2', handle: 'ghost', name: 'Ghost', mcp_approved: false };
      return null;
    },
    registerAgentRequest: async () => ({ registrationId: 'reg-1', status: 'approved' }),
    getRegistrationStatus: async () => ({ registrationId: 'reg-1', status: 'approved' }),
    roleHasWorkspaceCapability,
    rateLimiter: null,
    rateLimitBlocked: null,
    runtimeSchemaReady: Promise.resolve(),
    serverVersion: '9.9.9',
    ...overrides.deps,
  };
  return { deps, notifyCalls };
}

function makeRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    status(c) { this.statusCode = c; return this; },
    json(o) { this.body = o; return this; },
    end() { this.ended = true; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    getHeader(k) { return this.headers[k]; },
  };
}

async function call(handler, { token = 'agent-token', body }) {
  const req = { headers: token ? { authorization: `Bearer ${token}` } : {}, body, url: '/backend/mcp' };
  const res = makeRes();
  await handler(req, res);
  return res;
}

const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

const react = (handler, args, token = 'agent-token') =>
  call(handler, { token, body: rpc('tools/call', { name: 'react_to_message', arguments: args }) });

const payload = (res) => JSON.parse(res.body.result.content[0].text);

// ---------------------------------------------------------------------------

test('an agent can react as itself, and the write is bound to its own id', async () => {
  const db = makeDb();
  const { deps, notifyCalls } = makeDeps({ db });
  const res = await react(createMcpHandler(deps), { message_id: 'm-1', reaction: '👍' });

  assert.notEqual(res.body.result.isError, true, JSON.stringify(res.body.result));
  const out = payload(res);
  assert.equal(out.changed, true);
  assert.deepEqual(out.reactions['👍'], ['agent-1']);
  assert.equal(out.reacted_as.id, 'agent-1');

  const update = db.calls.find((c) => c.n.startsWith('update messages set reactions'));
  // The reactor is bound from the resolved identity, never from the arguments —
  // this is the forgeable-attribution defect the human lane was built to close,
  // and the agent lane must not reopen it.
  assert.deepEqual(update.params, ['m-1', 'ch-1', '👍', 'agent-1']);
  assert.equal(notifyCalls.filter((c) => c.table === 'messages' && c.ev === 'UPDATE').length, 1);
});

test('the mutation is one round trip: nothing reads the reactions map before it', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  await react(createMcpHandler(deps), { message_id: 'm-1', reaction: '👀' });

  const updateAt = db.calls.findIndex((c) => c.n.startsWith('update messages set reactions'));
  assert.ok(updateAt >= 0, 'the toggle must issue its UPDATE');
  const before = db.calls.slice(0, updateAt);
  for (const c of before) {
    assert.ok(
      !c.n.includes('reactions'),
      `read-modify-write reintroduced: "${c.n.slice(0, 80)}" reads the map before the write`,
    );
  }
  assert.equal(
    db.calls.filter((c) => c.n.startsWith('update messages set reactions')).length, 1,
    'exactly one mutating statement',
  );
});

test('the write is pinned to the session the authorization ran against', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  await react(createMcpHandler(deps), { message_id: 'm-1', reaction: '✅' });

  const gate = db.calls.find((c) => c.n.startsWith('select id from chat_sessions where id = $1'));
  const update = db.calls.find((c) => c.n.startsWith('update messages set reactions'));
  assert.equal(gate.params[0], 'ch-1');
  // Authorizing one row and mutating another is the classic shape of this bug.
  assert.equal(update.params[1], gate.params[0]);
});

test('a message in another workspace is not found, and nothing is written', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const res = await react(createMcpHandler(deps), { message_id: 'm-x', reaction: '👍' });

  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not found in this workspace/i);
  assert.equal(db.calls.filter((c) => c.n.startsWith('update messages set reactions')).length, 0);
});

test('a control-character reaction is refused before any statement runs', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const res = await react(createMcpHandler(deps), { message_id: 'm-1', reaction: 'a\nb' });

  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /reaction is required/i);
  assert.equal(db.calls.length, 0, 'a malformed reaction must not reach the database');
});

test('op must be add or remove; remove takes the agent\'s own reaction back', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);

  const bad = await react(handler, { message_id: 'm-1', reaction: '👍', op: 'toggle' });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /'add' or 'remove'/);

  const removed = await react(handler, { message_id: 'm-held', reaction: '✅', op: 'remove' });
  assert.notEqual(removed.body.result.isError, true);
  // The key is deleted, not left as an empty array — a reaction nobody holds
  // reads as ABSENT everywhere else in the system.
  assert.equal(Object.prototype.hasOwnProperty.call(payload(removed).reactions, '✅'), false);
});

test('a repeat add is a no-op answer, not an error', async () => {
  const db = makeDb({ updateReturnsNothing: true });
  const { deps } = makeDeps({ db });
  const res = await react(createMcpHandler(deps), { message_id: 'm-held', reaction: '✅' });

  assert.notEqual(res.body.result.isError, true, JSON.stringify(res.body.result));
  assert.equal(payload(res).changed, false);
});

test('a zero-row write the agent does not already hold reports not-found, not success', async () => {
  const db = makeDb({ updateReturnsNothing: true });
  const { deps } = makeDeps({ db });
  const res = await react(createMcpHandler(deps), { message_id: 'm-1', reaction: '👍' });

  // The statement refused it (revoked mid-write, or a session this agent may not
  // touch). Reporting changed:false here would tell an agent its reaction landed.
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /not found/i);
});

test('a workspace client must name the agent, and only an MCP-approved one', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);

  const anonymous = await react(handler, { message_id: 'm-1', reaction: '👍' }, 'ws-token');
  assert.equal(anonymous.body.result.isError, true);
  assert.match(anonymous.body.result.content[0].text, /as: "<agent handle>"/);

  const unapproved = await react(handler, { message_id: 'm-1', reaction: '👍', as: 'ghost' }, 'ws-token');
  assert.equal(unapproved.body.result.isError, true);
  assert.match(unapproved.body.result.content[0].text, /not been approved for mcp/i);
  assert.equal(db.calls.filter((c) => c.n.startsWith('update messages set reactions')).length, 0);

  const approved = await react(handler, { message_id: 'm-1', reaction: '👍', as: 'coder' }, 'ws-token');
  assert.notEqual(approved.body.result.isError, true);
  assert.equal(payload(approved).reacted_as.id, 'agent-1');
});

test('the tool is offered to agents and withheld from a flow integration', async () => {
  const db = makeDb();
  const { deps } = makeDeps({ db });
  const handler = createMcpHandler(deps);

  const agentTools = (await call(handler, { token: 'agent-token', body: rpc('tools/list') }))
    .body.result.tools.map((t) => t.name);
  assert.ok(agentTools.includes('react_to_message'));

  // A flow connection is not an agent: it has no workspace_agents row, so there
  // is no id the reactions map could honestly carry for it.
  const flowTools = (await call(handler, { token: 'flow-token', body: rpc('tools/list') }))
    .body.result.tools.map((t) => t.name);
  assert.ok(!flowTools.includes('react_to_message'));

  const denied = await react(handler, { message_id: 'm-1', reaction: '👍' }, 'flow-token');
  assert.equal(denied.body.result.isError, true);
  assert.equal(db.calls.filter((c) => c.n.startsWith('update messages set reactions')).length, 0);
});

// -- Structural: what the statement itself must say -------------------------

test('the agent statements authorize an AGENT, never a person', async () => {
  for (const sql of [AGENT_REACTION_ADD_SQL, AGENT_REACTION_REMOVE_SQL, AGENT_REACTION_CURRENT_SQL]) {
    assert.ok(sql.includes('workspace_agents'), 'the reactor must be resolved in workspace_agents');
    assert.ok(sql.includes('enabled is not false'), 'a disabled agent must write nothing');
    assert.ok(
      sql.includes('reacting_agent.workspace_id = reaction_session_scope.workspace_id'),
      'the agent and the session must belong to the same tenant',
    );
    assert.ok(sql.includes("->>'agent_id'"), 'participation is what opens a private session');
    assert.ok(sql.includes('for share'), 'a revoke landing mid-write must fail closed, not race');
    // The human lane authorizes through chat_session_members. An agent reaching
    // that predicate would be an agent authorized as a person.
    assert.ok(!sql.includes('chat_session_members'), 'the agent lane must not borrow the human predicate');
  }
  assert.ok(REACTION_ADD_SQL.includes('chat_session_members'), 'the human lane is unchanged');
});

test('the agent add statement keeps the human lane\'s guards verbatim', () => {
  // The containment test is what makes the transition exact — and therefore what
  // makes priorReactionMap a pure function of the after-image. Both lanes share
  // that reconstruction, so both must share the guard.
  assert.ok(AGENT_REACTION_ADD_SQL.includes('@> to_jsonb($4::text)'));
  assert.ok(AGENT_REACTION_REMOVE_SQL.includes('@> to_jsonb($4::text)'));
  assert.ok(AGENT_REACTION_ADD_SQL.includes(String(MAX_DISTINCT_REACTIONS_PER_MESSAGE)));
  assert.equal(agentReactionToggleSql('add'), AGENT_REACTION_ADD_SQL);
  assert.equal(agentReactionToggleSql('remove'), AGENT_REACTION_REMOVE_SQL);
  assert.throws(() => agentReactionToggleSql('toggle'), /Unknown reaction op/);
});
