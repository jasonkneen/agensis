'use strict';

// POST /backend/huddles/transcript — the voice worker writing what was said into
// the channel the huddle belongs to.
//
// This is a route a WORKER PROCESS calls with a machine credential, so the
// authorization properties are the whole test: the credential names exactly one
// agent in exactly one workspace, and the HUDDLE decides where the text lands —
// never the caller. A valid credential aimed at another workspace's huddle, or
// carrying its own sessionId, must not be able to write anywhere it likes.

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const mountHuddleRoutes = require('../server/huddles.cjs');

const HUDDLE = {
  id: 'hud-1',
  workspace_id: 'ws-1',
  session_id: 'chan-1',
  transcript_session_id: 'transcript-1',
  room_name: 'agensis-hud-1',
  ended_at: null,
};

function harness({ huddles = [HUDDLE], verify = null } = {}) {
  const inserted = [];
  const db = {
    unsafe: async (sql, params = []) => {
      if (/from huddles/.test(sql)) {
        return huddles.filter((h) => h.id === params[0] && h.workspace_id === params[1]);
      }
      if (/insert into messages/.test(sql)) {
        const row = {
          session_id: params[0], role: params[1], content: params[2],
          sender_kind: params[3], sender_id: params[4], sender_name: params[5], huddle_id: params[6],
        };
        inserted.push(row);
        return [row];
      }
      return [];
    },
  };

  const app = express();
  app.use(express.json());
  const mount = mountHuddleRoutes.mountHuddleRoutes || mountHuddleRoutes;
  mount(app, {
    getDb: () => db,
    requireAuth: (req, _res, next) => next(),
    enforceWorkspaceRole: async () => {},
    enforceSessionRead: async () => {},
    sessionReadableSql: () => 'true',
    assertWorkspaceRoleLocked: async () => {},
    installCreatedSessionMemberships: async () => {},
    lockPrivateSessionRoster: async () => {},
    jsonError: (res, status, error) => res.status(status).json({ data: null, error: { message: error.message } }),
    notifyDbSubscribers: () => {},
    verifyVoiceSessionToken: verify || (async (token) => (
      token === 'agv_good'
        ? { kind: 'agent', agentId: 'a1', workspaceId: 'ws-1', name: 'Claude', handle: 'claude' }
        : null
    )),
  });
  return { app, inserted };
}

async function post(app, body, token) {
  const server = app.listen(0);
  const { port } = server.address();
  try {
    const response = await fetch(`http://127.0.0.1:${port}/backend/huddles/transcript`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
  }
}

test('an agent turn lands in the huddle transcript session', async () => {
  const { app, inserted } = harness();
  const res = await post(app, { huddleId: 'hud-1', role: 'assistant', content: 'Two open tasks.' }, 'agv_good');

  assert.equal(res.status, 200);
  assert.equal(res.body.data.written, true);
  assert.equal(inserted.length, 1);
  assert.deepEqual(
    { ...inserted[0] },
    {
      session_id: 'transcript-1',
      role: 'assistant',
      content: 'Two open tasks.',
      sender_kind: 'agent',
      sender_id: 'a1',
      sender_name: 'Claude',
      huddle_id: 'hud-1',
    },
    'attributed to the agent the CREDENTIAL names, not anything the body claimed',
  );
});

test('a human turn is attributed as a person, never as the agent', async () => {
  const { app, inserted } = harness();
  await post(app, { huddleId: 'hud-1', role: 'user', content: 'what is left?', speaker: 'Jason' }, 'agv_good');
  assert.equal(inserted[0].sender_kind, 'user');
  assert.equal(inserted[0].sender_name, 'Jason');
  assert.equal(inserted[0].sender_id, '', 'a human line must not carry the agent id');
});

test('the credential is required and must verify', async () => {
  const { app, inserted } = harness();
  assert.equal((await post(app, { huddleId: 'hud-1', role: 'user', content: 'hi' })).status, 401);
  assert.equal((await post(app, { huddleId: 'hud-1', role: 'user', content: 'hi' }, 'agv_forged')).status, 401);
  assert.equal(inserted.length, 0);
});

test('a credential cannot write into another workspace\'s huddle', async () => {
  // Same huddle id, different workspace: the lookup is scoped by BOTH, so this
  // must read as "not found" rather than writing into someone else's channel.
  const { app, inserted } = harness({ huddles: [{ ...HUDDLE, workspace_id: 'ws-OTHER' }] });
  const res = await post(app, { huddleId: 'hud-1', role: 'assistant', content: 'leak' }, 'agv_good');
  assert.equal(res.status, 404);
  assert.equal(inserted.length, 0);
});

test('the huddle decides the destination, not the caller', async () => {
  const { app, inserted } = harness();
  await post(app, {
    huddleId: 'hud-1', role: 'assistant', content: 'x',
    sessionId: 'some-other-channel', // ignored on purpose
  }, 'agv_good');
  assert.equal(inserted[0].session_id, 'transcript-1');
});

test('an ended huddle and an empty line are refused quietly, not with a 500', async () => {
  const ended = harness({ huddles: [{ ...HUDDLE, ended_at: new Date().toISOString() }] });
  const res = await post(ended.app, { huddleId: 'hud-1', role: 'assistant', content: 'late' }, 'agv_good');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.written, false);
  assert.equal(ended.inserted.length, 0);

  const live = harness();
  const empty = await post(live.app, { huddleId: 'hud-1', role: 'user', content: '   ' }, 'agv_good');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.data.written, false);
  assert.equal(live.inserted.length, 0);
});

test('a runaway turn is truncated rather than writing an unbounded row', async () => {
  const { app, inserted } = harness();
  await post(app, { huddleId: 'hud-1', role: 'assistant', content: 'x'.repeat(20_000) }, 'agv_good');
  assert.equal(inserted[0].content.length, 8000);
});
