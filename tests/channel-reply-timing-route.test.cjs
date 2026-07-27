'use strict';

// ============================================================================
// tests/channel-reply-timing-route.test.cjs
// ----------------------------------------------------------------------------
// Two route-level guarantees, both of which are the difference between a
// feature and an inert setting:
//
//   A. RESERVED HANDLE. `channel` cannot be given to an agent through the doors
//      that mint one — the generic /backend/db insert and update. Refused with a
//      400 that names the handle, not silently mangled: a renamed handle is an
//      agent nobody can @mention. Mirrored on the Netlify backend, asserted
//      structurally below.
//
//   B. REPLY TIMING. POST /backend/agents/dispatch must give the same answer
//      continueConversation would. A channel set to 'mention' tells the client
//      dispatched:false with a reason it can recognise, instead of
//      dispatched:true for a post nobody will ever answer. An @mention (and
//      @channel) still dispatches in BOTH modes — the mode governs silence, not
//      being asked directly.
//
// The client's half of (B) is in src/hooks/useChat.ts: a deliberate non-dispatch
// must not trigger the direct-AI fallback or the "couldn't reach the agent"
// notice. The reason string is the contract between the two, so it is asserted
// literally here.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { createApp, __test } = require('../server/index.cjs');

const USER = 'user-1';
const WORKSPACE = 'w1';
const SESSION = 'chan-1';
const AGENT = {
  id: 'agent-1', workspace_id: WORKSPACE, name: 'Coder', handle: 'coder',
  enabled: true, model: 'claude-sonnet-4-6', run_mode: 'daemon',
};
// A SECOND agent, because the feature is about a channel with several agents in
// it — and because a channel with exactly one agent participant has a
// directTarget (the sole-agent fallback), which is a different branch.
const AGENT_2 = {
  id: 'agent-2', workspace_id: WORKSPACE, name: 'Scout', handle: 'scout',
  enabled: true, model: 'claude-sonnet-4-6', run_mode: 'daemon',
};

test.afterEach(() => __test.resetTestState());

function makeDb({ session, agents = [AGENT, AGENT_2] }) {
  const writes = { agentInserts: [], agentUpdates: [], messageInserts: [] };
  const db = {
    writes,
    async unsafe(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'reply-timing-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select 1 from workspaces where id')) {
        return String(params[1]) === USER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) return [];
      if (/^select workspace_id from "?workspace_agents"? where id/.test(q)) return [{ workspace_id: WORKSPACE }];
      if (q.includes('from chat_sessions where id')) return [session];
      if (q.startsWith('select * from workspace_agents where workspace_id')) return agents;
      if (q.startsWith('select id, name, handle, enabled from workspace_agents')) return agents;
      if (q.startsWith('insert into "workspace_agents"') || q.startsWith('insert into workspace_agents')) {
        writes.agentInserts.push({ sql: q, params });
        return [{ id: 'new-agent', workspace_id: WORKSPACE }];
      }
      if (q.startsWith('update "workspace_agents" set') || q.startsWith('update workspace_agents set')) {
        writes.agentUpdates.push({ sql: q, params });
        return [{ id: AGENT.id, workspace_id: WORKSPACE }];
      }
      if (q.startsWith('insert into messages')) {
        writes.messageInserts.push({ sql: q, params });
        return [{ id: `m-${writes.messageInserts.length}`, session_id: SESSION }];
      }
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
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

function post(baseUrl, token, route, body) {
  return fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function channelSession(overrides = {}) {
  return {
    id: SESSION, workspace_id: WORKSPACE, folder: 'Channels',
    conversation_mode: 'auto',
    participants: [
      { id: `agent:${AGENT.id}`, kind: 'agent', agent_id: AGENT.id, name: AGENT.name, handle: AGENT.handle },
      { id: `agent:${AGENT_2.id}`, kind: 'agent', agent_id: AGENT_2.id, name: AGENT_2.name, handle: AGENT_2.handle },
    ],
    ...overrides,
  };
}

// --- A: the reserved handle -------------------------------------------------

test('creating an agent with the handle `channel` is refused with 400', async () => {
  const db = makeDb({ session: channelSession() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/db/insert', {
      table: 'workspace_agents',
      values: { workspace_id: WORKSPACE, name: 'Everyone', handle: 'channel' },
      single: true,
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.match(String(payload.error?.message || payload.error), /@channel/);
    assert.match(String(payload.error?.message || payload.error), /reserved/);
  });
  assert.equal(db.writes.agentInserts.length, 0, 'nothing was written');
});

test('the refusal folds case and tolerates a leading @, so the door cannot be walked around', async () => {
  const db = makeDb({ session: channelSession() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    for (const handle of ['Channel', 'CHANNEL', '@channel', ' channel ']) {
      const res = await post(baseUrl, token, '/backend/db/insert', {
        table: 'workspace_agents',
        values: { workspace_id: WORKSPACE, name: 'Everyone', handle },
        single: true,
      });
      assert.equal(res.status, 400, `handle ${JSON.stringify(handle)} must be refused`);
    }
  });
  assert.equal(db.writes.agentInserts.length, 0);
});

test('renaming an existing agent INTO `channel` is refused too', async () => {
  const db = makeDb({ session: channelSession() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/db/update', {
      table: 'workspace_agents',
      values: { handle: 'channel' },
      filters: [{ column: 'id', operator: 'eq', value: AGENT.id }],
    });
    assert.equal(res.status, 400);
  });
  assert.equal(db.writes.agentUpdates.length, 0, 'no update ran');
});

test('an ordinary handle still creates fine — the guard is not a blanket refusal', async () => {
  const db = makeDb({ session: channelSession() });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/db/insert', {
      table: 'workspace_agents',
      values: { workspace_id: WORKSPACE, name: 'Channels Team', handle: 'channels' },
      single: true,
    });
    assert.equal(res.status, 200, '`channels` is a different handle and is allowed');
  });
  assert.equal(db.writes.agentInserts.length, 1);
});

test('MCP self-registration cannot claim the handle either', async () => {
  // The one door an UNTRUSTED client chooses its own handle through. A pending
  // registration with a reserved handle could only ever be approved into an
  // agent nobody can @mention, so it is refused before the row is written.
  __test.setTestDb(makeDb({ session: channelSession() }));
  await assert.rejects(
    () => __test.registerAgentRequest({ workspaceId: WORKSPACE, handle: 'channel', clientLabel: 'test' }),
    /reserved/,
  );
  await assert.rejects(
    () => __test.registerAgentRequest({ workspaceId: WORKSPACE, name: '@Channel', clientLabel: 'test' }),
    /reserved/,
  );
});

// --- Netlify parity ---------------------------------------------------------

test('the Netlify backend carries the SAME reserved-handle guard', () => {
  // Structural, not behavioural, and deliberately so: this repo's most repeated
  // bug is a rule wired into one backend and silently missing from the other,
  // and both db routes are reachable in a real deploy. A behavioural test here
  // would need the whole serverless harness; what actually regresses is someone
  // editing one file and not the other.
  const netlify = fs.readFileSync(path.resolve(__dirname, '..', 'netlify', 'functions', 'backend.mjs'), 'utf8');
  assert.match(netlify, /from '\.\.\/\.\.\/shared\/channelMentions\.cjs'/, 'imports the shared decision');
  const guards = netlify.match(/isReservedAgentHandle\(/g) || [];
  assert.ok(guards.length >= 2, `expected the guard on both insert and update, found ${guards.length}`);
  assert.match(netlify, /reservedAgentHandleMessage\(/, 'and surfaces the same wording');

  // Both backends must mint handles through the shared slugger, or a handle
  // created on one is not the string an @mention of it produces on the other.
  const fly = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.cjs'), 'utf8');
  for (const [name, source] of [['netlify', netlify], ['fly', fly]]) {
    assert.match(source, /function slugHandle\(value\) \{\s*return slugMentionHandle\(value\);/, `${name} delegates slugHandle`);
  }
});

// --- B: reply timing --------------------------------------------------------

test("an un-addressed post in an 'auto' channel dispatches, as it always has", async () => {
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'auto' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'anyone seen the deploy logs',
    });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
    assert.equal(data.mode, 'auto');
  });
});

test("an un-addressed post in a 'social' channel still dispatches — paced is not silent", async () => {
  // The failure this catches is invisible: 'social' is a value on the same axis
  // as 'mention', and if the route's gate (allowsUnpromptedReply) treated
  // anything-but-'auto' as silence, the composer would be told dispatched:false
  // and no agent would ever speak in a social channel. Cadence delays a reply
  // INSIDE continueConversation; the route's answer is unchanged.
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'social' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'saw a heron on the way in',
    });
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
    assert.equal(data.mode, 'auto', 'the dispatch MODE descriptor is about addressing, not timing');
  });
});

test("an @mention in a 'social' channel dispatches exactly as anywhere else", async () => {
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'social' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: '@coder did you see this',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
    assert.equal(data.mode, 'mention');
    assert.deepEqual(data.mentions, ['coder']);
  });
});

test("an un-addressed post in a 'mention' channel dispatches NOBODY, with a reason", async () => {
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'mention' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'anyone seen the deploy logs',
    });
    assert.equal(res.status, 200, 'not an error — the message was posted, nobody was summoned');
    const { data } = await res.json();
    assert.equal(data.dispatched, false);
    // The literal contract with useChat.ts, which uses it to tell "the channel
    // chose not to answer" apart from "dispatch broke". Changing this string
    // without changing that constant reinstates the "couldn't reach the agent"
    // notice on a message that worked exactly as configured.
    assert.equal(data.reason, 'channel_replies_on_mention_only');
  });
});

test("an @mention still dispatches in a 'mention' channel — the mode governs silence, not being asked", async () => {
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'mention' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: '@coder can you look',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
    assert.equal(data.mode, 'mention');
    assert.deepEqual(data.mentions, ['coder']);
  });
});

test("@channel dispatches in a 'mention' channel, and reports itself as such", async () => {
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'mention' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: '@channel standup please',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
    assert.equal(data.mode, 'channel');
    // `mentions` lists INDIVIDUAL handles; @channel is not one, so it stays out
    // of the list rather than appearing as a phantom agent named "channel".
    assert.deepEqual(data.mentions, []);
  });
});

test("a DM whose row says 'mention' still answers a plain message", async () => {
  // A DM's single agent replying without being @mentioned is what makes it a DM.
  // A stale mode on a DM row must not wedge it — silently, with no way for the
  // human to tell why the agent stopped talking.
  const dm = channelSession({
    folder: 'Direct messages',
    conversation_mode: 'mention',
    participants: [{ id: `agent:${AGENT.id}`, kind: 'agent', agent_id: AGENT.id, name: AGENT.name, handle: AGENT.handle, direct: true }],
  });
  __test.setTestDb(makeDb({ session: dm }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'morning',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
    assert.equal(data.mode, 'direct');
  });
});

test("a LEGACY folder-DM with no direct-flagged participant also still answers", async () => {
  // These rows predate the direct flag; the mode gate has to recognise them by
  // folder or it silences exactly the DMs least able to explain themselves.
  // This is why `folder` is in the route's column projection.
  const legacy = channelSession({
    folder: 'Direct messages',
    conversation_mode: 'mention',
    participants: [],
  });
  __test.setTestDb(makeDb({ session: legacy }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'morning',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true, 'a legacy DM is never silenced by the mode');
  });
});

test('the dispatch route projects `folder`, without which the legacy-DM check reads undefined', () => {
  // The blank-column trap, asserted directly: an explicit column list that omits
  // a column a decision reads does not error, it just takes the other branch.
  const fly = fs.readFileSync(path.resolve(__dirname, '..', 'server', 'index.cjs'), 'utf8');
  assert.match(
    fly,
    /select id, workspace_id, participants, conversation_mode, folder from chat_sessions where id = \$1 limit 1/,
  );
});

test("a channel with a SINGLE agent honours 'mention' too", async () => {
  // A one-agent channel has a directTarget (the sole-agent fallback) even though
  // it is not a DM, and an un-addressed post there used to wake it
  // unconditionally. Without gating that branch, "nobody has to answer" was a
  // setting that quietly did nothing until a second agent joined — which is the
  // kind of half-working the human discovers weeks later.
  const solo = channelSession({
    conversation_mode: 'mention',
    participants: [{ id: `agent:${AGENT.id}`, kind: 'agent', agent_id: AGENT.id, name: AGENT.name, handle: AGENT.handle }],
  });
  __test.setTestDb(makeDb({ session: solo, agents: [AGENT] }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const plain = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'thinking out loud',
    });
    assert.equal((await plain.json()).data.dispatched, false);

    const asked = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: '@coder thoughts?',
    });
    assert.equal((await asked.json()).data.dispatched, true, 'asking still works');
  });
});

test("the same channel in 'auto' keeps waking its single agent, as before", async () => {
  const solo = channelSession({
    conversation_mode: 'auto',
    participants: [{ id: `agent:${AGENT.id}`, kind: 'agent', agent_id: AGENT.id, name: AGENT.name, handle: AGENT.handle }],
  });
  __test.setTestDb(makeDb({ session: solo, agents: [AGENT] }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'thinking out loud',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true, 'the default is unchanged for every existing channel');
    assert.equal(data.mode, 'direct');
  });
});

test('an unrecognised conversation_mode behaves as auto, never as silence', async () => {
  // Failing to 'mention' would silence channels nobody asked to silence — the
  // worse of the two failures, because it is invisible.
  __test.setTestDb(makeDb({ session: channelSession({ conversation_mode: 'nonsense' }) }));
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await post(baseUrl, token, '/backend/agents/dispatch', {
      workspaceId: WORKSPACE, sessionId: SESSION, content: 'plain message',
    });
    const { data } = await res.json();
    assert.equal(data.dispatched, true);
  });
});
