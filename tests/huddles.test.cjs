'use strict';

// ============================================================================
// tests/huddles.test.cjs
// ----------------------------------------------------------------------------
// Huddles = LiveKit voice in a channel. Four things have to hold or this is
// either a leak or a lie:
//
//   1. MEMBERSHIP. A non-member must never receive a join token. A LiveKit token
//      is a bearer credential for a live audio room; handing one to a stranger
//      puts them in the call. The 403 must land BEFORE the minter is reached.
//   2. WEBHOOK SIGNATURE. Participant state is trusted from LiveKit and nowhere
//      else, so an unsigned/forged/replayed webhook must be rejected and must
//      write nothing. If this check is wrong, anyone can forge "who was in the
//      call" for any workspace.
//   3. THE FOLD. Append-only events folded into state, tolerant of duplicates
//      and out-of-order delivery — and an ended huddle reports ZERO
//      participants. `Math.max(1, participants.size)` is exactly how an earlier
//      implementation ended up claiming "1 participant" forever.
//   4. THE THREE-PLACE SCHEMA RULE (AGENTS.md), plus the access allowlists.
//
// No live Postgres and no LiveKit: the DB is a recording fake (same pattern as
// tests/inbox.test.cjs) and the token minter is injected. A real LiveKit media
// session is NOT exercised here — it cannot be, from a test process.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const { __test } = require('../server/index.cjs');
const core = require('../shared/backend-core.cjs');
const huddles = require('../server/huddles.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const WS = '11111111-1111-4111-8111-111111111111';
const OTHER_WS = '22222222-2222-4222-8222-222222222222';
const SESSION = '33333333-3333-4333-8333-333333333333';
const MEMBER = 'user-member';
const VIEWER = 'user-viewer';
const STRANGER = 'user-stranger';
const HUDDLE_ID = '44444444-4444-4444-8444-444444444444';
const ROOM = `agensis-${HUDDLE_ID}`;

const API_KEY = 'APItestkey';
const API_SECRET = 'test-api-secret-not-a-real-one';

// --- fakes ------------------------------------------------------------------

// Mirrors server/index.cjs's requireAuth exactly (it is not exported). The real
// membership check IS the real one: __test.enforceWorkspaceRole.
function jsonError(res, status, error) {
  res.status(status).json({ data: null, error: { message: error?.message || 'Error', code: error?.code || null } });
}

async function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = await __test.verifyToken(token);
  if (!userId) return jsonError(res, 401, new Error('Authentication required'));
  req.userId = userId;
  next();
}

function makeDb({ roles = {}, owners = {}, sessions = { [SESSION]: WS }, huddleRows = [], eventRows = [] } = {}) {
  const calls = [];
  const state = { huddles: [...huddleRows], events: [...eventRows] };
  let seq = state.events.length;
  const db = {
    calls,
    state,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      calls.push({ sql: String(sql), normalized: n, params });
      if (
        n.startsWith('alter table') || n.startsWith('create table')
        || n.startsWith('create index') || n.startsWith('create unique index') || n.startsWith('do $$')
      ) return [];
      if (n.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'huddle-secret' }] : [];
      }
      if (n.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
        return owners[params[0]] === params[1] ? [{ ok: 1 }] : [];
      }
      if (n.startsWith('select role from workspace_members')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      if (n.startsWith('select display_name, email from app_users')) {
        return [{ display_name: 'Member', email: 'member@example.com' }];
      }
      if (n.startsWith('select id from chat_sessions where id = $1 and workspace_id = $2')) {
        return sessions[params[0]] === params[1] ? [{ id: params[0] }] : [];
      }
      if (n.startsWith('select id, workspace_id, session_id, room_name, started_by, started_at, ended_at from huddles where session_id = $1 and ended_at is null')) {
        return state.huddles.filter((h) => h.session_id === params[0] && !h.ended_at);
      }
      if (n.startsWith('select id, workspace_id, session_id, room_name, started_by, started_at, ended_at from huddles where session_id = $1 order by started_at desc')) {
        return state.huddles.filter((h) => h.session_id === params[0]).slice(-1);
      }
      if (n.startsWith('select id, workspace_id, session_id, room_name, started_by, started_at, ended_at from huddles where id = $1 and workspace_id = $2')) {
        return state.huddles.filter((h) => h.id === params[0] && h.workspace_id === params[1]);
      }
      if (n.startsWith('select id, workspace_id, session_id, room_name, started_by, started_at, ended_at from huddles where room_name = $1')) {
        return state.huddles.filter((h) => h.room_name === params[0]);
      }
      if (n.startsWith('select id, huddle_id, workspace_id, session_id, kind, identity, display_name, event_id, seq, created_at from huddle_events')) {
        return state.events.filter((e) => e.huddle_id === params[0]);
      }
      if (n.startsWith('insert into huddles')) {
        const [id, workspaceId, sessionId, roomName, startedBy] = params;
        if (state.huddles.some((h) => h.session_id === sessionId && !h.ended_at)) {
          const err = new Error('duplicate key value violates unique constraint "idx_huddles_one_live_per_session"');
          err.code = '23505';
          throw err;
        }
        const row = {
          id, workspace_id: workspaceId, session_id: sessionId, room_name: roomName,
          started_by: startedBy, started_at: new Date().toISOString(), ended_at: null,
        };
        state.huddles.push(row);
        return [row];
      }
      if (n.startsWith('insert into huddle_events')) {
        const [huddleId, workspaceId, sessionId, kind, identity, displayName, eventId, createdAt] = params;
        // Honour the partial unique index on event_id so a redelivered webhook
        // is a no-op here too — if the route stops passing LiveKit's event id
        // the dedup test below fails rather than silently passing.
        if (eventId && state.events.some((e) => e.event_id === eventId)) return [];
        seq += 1;
        const row = {
          id: `event-${seq}`, huddle_id: huddleId, workspace_id: workspaceId, session_id: sessionId,
          kind, identity, display_name: displayName, event_id: eventId, seq,
          created_at: createdAt || new Date().toISOString(),
        };
        state.events.push(row);
        return [row];
      }
      if (n.startsWith('update huddles set ended_at = now()')) {
        const row = state.huddles.find((h) => h.id === params[0] && !h.ended_at);
        if (!row) return [];
        row.ended_at = new Date().toISOString();
        return [row];
      }
      throw new Error(`Unexpected SQL in huddles test: ${sql}`);
    },
  };
  return db;
}

function makeApp(db, overrides = {}) {
  const minted = [];
  const broadcasts = [];
  const app = express();
  // Same rawBody capture createApp() installs (the webhook body hash needs the
  // untouched bytes).
  app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } }));
  huddles.mountHuddleRoutes(app, {
    getDb: () => db,
    requireAuth,
    enforceWorkspaceRole: __test.enforceWorkspaceRole,
    jsonError,
    notifyDbSubscribers: (table, eventType, rows) => broadcasts.push({ table, eventType, rows }),
    mintToken: async (args) => { minted.push(args); return `token-for-${args.identity}`; },
    endRoom: async () => true,
    ...overrides,
  });
  return { app, minted, broadcasts };
}

async function withServer(app, fn) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
}

// Sign a webhook exactly the way LiveKit does: HS256 JWT whose `sha256` claim is
// the BASE64 SHA-256 of the exact body, `iss` the API key.
function signWebhook(body, { apiKey = API_KEY, apiSecret = API_SECRET, sha256, alg = 'HS256', exp, nbf } = {}) {
  const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
  const claims = {
    iss: apiKey,
    exp: exp ?? Math.floor(Date.now() / 1000) + 300,
    sha256: sha256 ?? crypto.createHash('sha256').update(body).digest('base64'),
  };
  if (nbf !== undefined) claims.nbf = nbf;
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = crypto.createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

function webhookBody({ event, participant, id = 'evt-1', createdAt } = {}) {
  return JSON.stringify({
    event,
    id,
    createdAt: createdAt ?? Math.floor(Date.now() / 1000),
    room: { name: ROOM },
    ...(participant ? { participant } : {}),
  });
}

function liveHuddleRow(overrides = {}) {
  return {
    id: HUDDLE_ID,
    workspace_id: WS,
    session_id: SESSION,
    room_name: ROOM,
    started_by: MEMBER,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    ended_at: null,
    ...overrides,
  };
}

const savedEnv = {};
test.beforeEach(() => {
  __test.resetTestState();
  savedEnv.url = process.env.LIVEKIT_URL;
  savedEnv.key = process.env.LIVEKIT_API_KEY;
  savedEnv.secret = process.env.LIVEKIT_API_SECRET;
  process.env.LIVEKIT_URL = 'wss://example.livekit.cloud';
  process.env.LIVEKIT_API_KEY = API_KEY;
  process.env.LIVEKIT_API_SECRET = API_SECRET;
});
test.afterEach(() => {
  __test.resetTestState();
  for (const [envName, key] of [['LIVEKIT_URL', 'url'], ['LIVEKIT_API_KEY', 'key'], ['LIVEKIT_API_SECRET', 'secret']]) {
    if (savedEnv[key] === undefined) delete process.env[envName];
    else process.env[envName] = savedEnv[key];
  }
});

// --- 1. membership ----------------------------------------------------------

test('starting a huddle requires auth, and mints nothing', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  const { app, minted } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { method: 'POST' });
    assert.equal(res.status, 401);
    assert.equal(minted.length, 0);
  });
});

test('a NON-MEMBER cannot get a join token (403, minter never reached)', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, minted } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(STRANGER, '1');
    const auth = { Authorization: `Bearer ${token}` };

    // Start-or-join in the channel.
    const start = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { method: 'POST', headers: auth });
    assert.equal(start.status, 403);
    assert.equal((await start.json()).data, null);

    // Join by huddle id — the other door into the same credential.
    const join = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/join`, { method: 'POST', headers: auth });
    assert.equal(join.status, 403);

    // Read.
    const get = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(get.status, 403);

    // End.
    const end = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    assert.equal(end.status, 403);

    // The leak that matters: no token was minted for anyone.
    assert.equal(minted.length, 0);
    // And the huddle was not touched.
    assert.equal(db.state.huddles[0].ended_at, null);
  });
});

test('a VIEWER (read-only role) can see a huddle but cannot join it', async () => {
  const db = makeDb({
    roles: { [`${WS}:${VIEWER}`]: 'viewer' },
    huddleRows: [liveHuddleRow()],
  });
  __test.setTestDb(db);
  const { app, minted } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(VIEWER, '1');
    const auth = { Authorization: `Bearer ${token}` };

    const get = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(get.status, 200);

    const join = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/join`, { method: 'POST', headers: auth });
    assert.equal(join.status, 403);
    assert.equal(minted.length, 0);
  });
});

test('a member of another workspace cannot borrow this workspace session id', async () => {
  const db = makeDb({
    roles: { [`${OTHER_WS}:${STRANGER}`]: 'owner', [`${WS}:${MEMBER}`]: 'editor' },
    sessions: { [SESSION]: WS },
  });
  __test.setTestDb(db);
  const { app, minted } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(STRANGER, '1');
    // They ARE a member of OTHER_WS, and the session belongs to WS. Membership
    // alone is not enough: the session must live in the workspace we checked.
    const res = await fetch(`${baseUrl}/backend/workspaces/${OTHER_WS}/sessions/${SESSION}/huddle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 404);
    assert.equal(minted.length, 0);
  });
});

test('a member starts a huddle: one namespaced room, a token for THEMSELVES only', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  const { app, minted, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.error, null);
    assert.equal(body.data.created, true);
    // Namespaced because the LiveKit project is shared with other apps.
    assert.match(body.data.roomName, /^agensis-/);
    assert.equal(body.data.roomName, `agensis-${body.data.huddle.id}`);
    assert.equal(body.data.token, `token-for-user:${MEMBER}`);
    assert.equal(body.data.url, 'wss://example.livekit.cloud');
    // The identity is SERVER-assigned, so the webhook can attribute a join.
    assert.equal(body.data.identity, `user:${MEMBER}`);

    // Exactly one token, scoped to this room and this caller.
    assert.equal(minted.length, 1);
    assert.equal(minted[0].identity, `user:${MEMBER}`);
    assert.equal(minted[0].roomName, body.data.roomName);
    assert.ok(minted[0].ttlSeconds <= huddles.MAX_TOKEN_TTL_SECONDS);

    // A 'started' marker — NOT a synthetic participant_joined. Nobody has
    // connected to the room yet and the card must not claim they have.
    assert.equal(body.data.state.participantCount, 0);
    assert.deepEqual(body.data.events.map((e) => e.kind), ['started']);

    // Realtime fanout over the existing websocket path.
    assert.deepEqual(broadcasts.map((b) => `${b.table}:${b.eventType}`), ['huddles:INSERT', 'huddle_events:INSERT']);
  });
});

test('a second starter joins the SAME huddle instead of opening a second room', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.created, false);
    assert.equal(body.data.huddle.id, HUDDLE_ID);
    assert.equal(db.state.huddles.length, 1);
  });
});

test('joining an ENDED huddle is refused rather than minting a dead credential', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ ended_at: new Date().toISOString() })],
  });
  __test.setTestDb(db);
  const { app, minted } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/join`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 409);
    assert.equal(minted.length, 0);
  });
});

test('end is idempotent and reports a truthful, empty roster', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const auth = { Authorization: `Bearer ${token}` };
    const first = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.ok(firstBody.data.state.endedAt);
    assert.equal(firstBody.data.state.active, false);
    assert.equal(firstBody.data.state.participantCount, 0);
    const endedAt = db.state.huddles[0].ended_at;

    const second = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    assert.equal(second.status, 200);
    // A second End must not move the timestamp.
    assert.equal(db.state.huddles[0].ended_at, endedAt);
  });
});

// --- 2. webhook signature ---------------------------------------------------

test('verifyLivekitWebhook accepts a correctly-signed body', () => {
  const body = webhookBody({ event: 'participant_joined', participant: { identity: `user:${MEMBER}` } });
  const claims = huddles.verifyLivekitWebhook(signWebhook(body), Buffer.from(body), API_KEY, API_SECRET);
  assert.ok(claims);
  assert.equal(claims.iss, API_KEY);
});

test('verifyLivekitWebhook rejects every way the signature can be wrong', () => {
  const body = webhookBody({ event: 'participant_joined', participant: { identity: `user:${MEMBER}` } });
  const buf = Buffer.from(body);
  const reject = (label, header, rawBody = buf) => {
    assert.equal(huddles.verifyLivekitWebhook(header, rawBody, API_KEY, API_SECRET), null, label);
  };

  reject('missing header', '');
  reject('not a jwt', 'garbage');
  reject('two segments only', 'a.b');
  reject('signed with the wrong secret', signWebhook(body, { apiSecret: 'wrong-secret' }));
  reject('issued by a different LiveKit project', signWebhook(body, { apiKey: 'APIsomeoneelse' }));
  reject('expired', signWebhook(body, { exp: Math.floor(Date.now() / 1000) - 3600 }));
  reject('not yet valid', signWebhook(body, { nbf: Math.floor(Date.now() / 1000) + 3600 }));
  reject('alg confusion (alg: none)', signWebhook(body, { alg: 'none' }));
  reject('body hash does not match the claim', signWebhook(body, { sha256: crypto.createHash('sha256').update('other').digest('base64') }));

  // The replay that matters: a genuinely-signed token replayed over a DIFFERENT
  // body. The signature verifies; the sha256 binding is what stops it.
  const swapped = webhookBody({ event: 'room_finished' });
  reject('valid signature over a swapped body', signWebhook(body), Buffer.from(swapped));

  // And hex instead of base64 (the encoding LiveKit does NOT use) must fail.
  reject('hex body hash', signWebhook(body, { sha256: crypto.createHash('sha256').update(body).digest('hex') }));

  // No secret configured => never accept.
  assert.equal(huddles.verifyLivekitWebhook(signWebhook(body), buf, API_KEY, ''), null);
  assert.equal(huddles.verifyLivekitWebhook(signWebhook(body), buf, '', API_SECRET), null);
});

test('the webhook route rejects a forged signature with 401 and writes NOTHING', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = webhookBody({ event: 'participant_joined', participant: { identity: `user:${STRANGER}` } });
    const res = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body, { apiSecret: 'attacker' }) },
      body,
    });
    assert.equal(res.status, 401);
    // Forging participant state is the whole attack — no event, no broadcast.
    assert.equal(db.state.events.length, 0);
    assert.equal(broadcasts.length, 0);
  });
});

test('the webhook route fails CLOSED when no LiveKit secret is configured', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  delete process.env.LIVEKIT_API_SECRET;
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = webhookBody({ event: 'participant_joined', participant: { identity: `user:${MEMBER}` } });
    const res = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal(res.status, 503);
    assert.equal(db.state.events.length, 0);
  });
});

test('a signed participant_joined is recorded and broadcast', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = webhookBody({ event: 'participant_joined', participant: { identity: `user:${MEMBER}`, name: 'Member' } });
    const res = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(db.state.events.length, 1);
    assert.equal(db.state.events[0].kind, 'participant_joined');
    assert.equal(db.state.events[0].identity, `user:${MEMBER}`);
    assert.deepEqual(broadcasts.map((b) => `${b.table}:${b.eventType}`), ['huddle_events:INSERT']);
  });
});

test('a REDELIVERED webhook is a no-op (same LiveKit event id)', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = webhookBody({ event: 'participant_joined', participant: { identity: `user:${MEMBER}` }, id: 'evt-dup' });
    const post = () => fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal((await post()).status, 200);
    assert.equal((await post()).status, 200);
    assert.equal(db.state.events.length, 1, 'redelivery must not duplicate the participant');
    assert.equal(broadcasts.length, 1, 'and must not re-broadcast');
  });
});

test('room_finished ends the huddle server-side and broadcasts the change', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = webhookBody({ event: 'room_finished' });
    const res = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.ok(db.state.huddles[0].ended_at);
    assert.deepEqual(broadcasts.map((b) => `${b.table}:${b.eventType}`), ['huddle_events:INSERT', 'huddles:UPDATE']);
  });
});

test('a signed webhook for ANOTHER app in the shared LiveKit project is ignored', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = JSON.stringify({
      event: 'participant_joined',
      id: 'evt-other-app',
      createdAt: Math.floor(Date.now() / 1000),
      room: { name: 'someotherapp-room-9' },
      participant: { identity: 'someone' },
    });
    const res = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { data: { ignored: true }, error: null });
    assert.equal(db.state.events.length, 0);
  });
});

// --- 3. the fold ------------------------------------------------------------

const H = liveHuddleRow();
const ev = (kind, identity, at, extra = {}) => ({
  kind, identity, created_at: at, display_name: identity, seq: 0, ...extra,
});

test('the fold is idempotent under duplicate events', () => {
  const state = huddles.foldHuddleState(H, [
    ev('participant_joined', 'user:a', '2026-07-25T10:00:00.000Z', { seq: 1 }),
    ev('participant_joined', 'user:a', '2026-07-25T10:00:00.000Z', { seq: 2 }),
    ev('participant_left', 'user:a', '2026-07-25T10:05:00.000Z', { seq: 3 }),
    ev('participant_left', 'user:a', '2026-07-25T10:05:00.000Z', { seq: 4 }),
  ]);
  assert.equal(state.participantCount, 0);
  assert.equal(state.everJoinedCount, 1);
  assert.equal(state.peakParticipants, 1);
});

test('the fold is correct under OUT-OF-ORDER delivery', () => {
  // Same three events, shuffled: a leave delivered before its own join.
  const inOrder = [
    ev('participant_joined', 'user:a', '2026-07-25T10:00:00.000Z', { seq: 1 }),
    ev('participant_joined', 'user:b', '2026-07-25T10:01:00.000Z', { seq: 2 }),
    ev('participant_left', 'user:a', '2026-07-25T10:02:00.000Z', { seq: 3 }),
  ];
  const shuffled = [inOrder[2], inOrder[0], inOrder[1]];
  const a = huddles.foldHuddleState(H, inOrder);
  const b = huddles.foldHuddleState(H, shuffled);
  assert.deepEqual(b, a);
  assert.deepEqual(a.participants.map((p) => p.identity), ['user:b']);
  assert.equal(a.peakParticipants, 2);
});

test('an ENDED huddle reports ZERO participants — no Math.max(1, …) floor', () => {
  const state = huddles.foldHuddleState(liveHuddleRow({ ended_at: '2026-07-25T10:10:00.000Z' }), [
    ev('participant_joined', 'user:a', '2026-07-25T10:00:00.000Z', { seq: 1 }),
    ev('participant_joined', 'user:b', '2026-07-25T10:01:00.000Z', { seq: 2 }),
    // Note: NO participant_left events. LiveKit may never send them if the room
    // is torn down, which is exactly the case that produced "1 participant"
    // forever in the implementation this replaces.
  ]);
  assert.equal(state.active, false);
  assert.equal(state.participantCount, 0);
  assert.deepEqual(state.participants, []);
  // The truthful answers to "how many were here" survive.
  assert.equal(state.peakParticipants, 2);
  assert.equal(state.everJoinedCount, 2);
});

test('an ended event in the log ends the huddle even before the row is updated', () => {
  const state = huddles.foldHuddleState(H, [
    ev('participant_joined', 'user:a', '2026-07-25T10:00:00.000Z', { seq: 1 }),
    ev('ended', '', '2026-07-25T10:03:00.000Z', { seq: 2 }),
  ]);
  assert.equal(state.active, false);
  assert.equal(state.endedAt, '2026-07-25T10:03:00.000Z');
  assert.equal(state.participantCount, 0);
});

test('room names are namespaced, and foreign room names are not claimed', () => {
  assert.equal(huddles.roomNameForHuddle('abc'), 'agensis-abc');
  assert.equal(huddles.huddleIdFromRoomName('agensis-abc'), 'abc');
  assert.equal(huddles.huddleIdFromRoomName('otherapp-abc'), '');
  assert.equal(huddles.huddleIdFromRoomName(''), '');
});

test('the join grant is room-scoped and carries no admin powers', () => {
  const grant = huddles.buildJoinGrant('agensis-x');
  assert.equal(grant.room, 'agensis-x');
  assert.equal(grant.roomJoin, true);
  assert.equal(grant.canPublish, true);
  assert.equal(grant.canSubscribe, true);
  // Anything that would let a participant manage the LiveKit project must be absent.
  for (const forbidden of ['roomAdmin', 'roomCreate', 'roomList', 'roomRecord', 'ingressAdmin']) {
    assert.equal(grant[forbidden], undefined, `grant must not include ${forbidden}`);
  }
});

test('token TTL is clamped so a bad env var cannot mint a long-lived credential', () => {
  const saved = process.env.LIVEKIT_TOKEN_TTL_SECONDS;
  try {
    process.env.LIVEKIT_TOKEN_TTL_SECONDS = '999999';
    assert.equal(huddles.tokenTtlSeconds(), huddles.MAX_TOKEN_TTL_SECONDS);
    process.env.LIVEKIT_TOKEN_TTL_SECONDS = '1';
    assert.equal(huddles.tokenTtlSeconds(), huddles.MIN_TOKEN_TTL_SECONDS);
    process.env.LIVEKIT_TOKEN_TTL_SECONDS = 'nonsense';
    assert.equal(huddles.tokenTtlSeconds(), huddles.DEFAULT_TOKEN_TTL_SECONDS);
    delete process.env.LIVEKIT_TOKEN_TTL_SECONDS;
    assert.equal(huddles.tokenTtlSeconds(), huddles.DEFAULT_TOKEN_TTL_SECONDS);
  } finally {
    if (saved === undefined) delete process.env.LIVEKIT_TOKEN_TTL_SECONDS;
    else process.env.LIVEKIT_TOKEN_TTL_SECONDS = saved;
  }
});

// --- 4. schema + allowlists -------------------------------------------------

test('huddles + huddle_events are declared in all three schema places', () => {
  // Runtime bootstrap: server/huddles.cjs owns the DDL (server/index.cjs calls
  // ensureHuddlesSchema from ensureRuntimeSchema; the DDL itself lives here so
  // the module is self-contained).
  const runtime = huddles.HUDDLES_SCHEMA_SQL;
  const canonical = read('database/neon-schema.sql');
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((n) => n.endsWith('_huddles.sql'));
  assert.equal(migrations.length, 1, 'expected exactly one huddles migration');
  const migration = read(path.join('supabase/migrations', migrations[0]));

  for (const [label, source] of [['runtime', runtime], ['neon-schema', canonical], ['migration', migration]]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS huddles \(/, label);
    assert.match(source, /CREATE TABLE IF NOT EXISTS huddle_events \(/, label);
    assert.match(source, /workspace_id uuid NOT NULL REFERENCES workspaces\(id\) ON DELETE CASCADE/, label);
    assert.match(source, /session_id uuid NOT NULL REFERENCES chat_sessions\(id\) ON DELETE CASCADE/, label);
    assert.match(source, /room_name text NOT NULL UNIQUE/, label);
    assert.match(source, /started_by uuid/, label);
    assert.match(source, /started_at timestamptz NOT NULL DEFAULT now\(\)/, label);
    assert.match(source, /ended_at timestamptz/, label);
    // One live huddle per channel: this index is what makes two simultaneous
    // "Huddle" presses land in ONE room.
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS idx_huddles_one_live_per_session ON huddles\(session_id\) WHERE ended_at IS NULL/, label);
    // Webhook redelivery is a no-op at the DB level, not just in app code.
    assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS idx_huddle_events_event_id ON huddle_events\(event_id\) WHERE event_id <> ''/, label);
  }
});

test('neon-schema.sql creates huddles AFTER the tables it references', () => {
  // psql applies the file top-to-bottom with ON_ERROR_STOP=1, so a forward
  // REFERENCES breaks fresh-DB provisioning outright.
  const lines = read('database/neon-schema.sql').split('\n');
  const created = new Map();
  lines.forEach((raw, index) => {
    const text = raw.replace(/--.*$/, '');
    const create = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([a-zA-Z_][a-zA-Z0-9_]*)"?/i.exec(text);
    if (create && !created.has(create[1])) created.set(create[1], index + 1);
  });
  assert.ok(created.has('huddles'), 'huddles missing from neon-schema.sql');
  assert.ok(created.has('huddle_events'), 'huddle_events missing from neon-schema.sql');
  assert.ok(created.get('huddles') > created.get('workspaces'));
  assert.ok(created.get('huddles') > created.get('chat_sessions'));
  assert.ok(created.get('huddle_events') > created.get('huddles'));
});

test('huddle tables are readable through /backend/db but NOT writable by a client', () => {
  for (const table of ['huddles', 'huddle_events']) {
    assert.equal(core.ALLOWED_TABLES.has(table), true, `${table} in ALLOWED_TABLES`);
    assert.equal(core.WORKSPACE_SCOPED_TABLES.has(table), true, `${table} is workspace-scoped`);
    const access = core.DB_TABLE_ACCESS[table];
    assert.equal(access.select, 'read');
    // Writes go through the dedicated routes (which mint the token) and the
    // signed webhook. If a browser could insert a huddle_events row it could
    // claim someone was in a call — the exact property this feature relies on.
    for (const action of ['insert', 'update', 'delete']) {
      assert.equal(access[action], 'manage', `${table}.${action} must require 'manage'`);
    }
  }
});

test('the deploy headers permit a microphone at all', () => {
  // The single most silent way to ship a dead voice feature: netlify.toml's
  // ENFORCED Permissions-Policy said `microphone=()`, which blocks
  // getUserMedia({audio:true}) app-wide no matter what the app code does — no
  // console error a user would report, just a call where nobody can be heard.
  const toml = read('netlify.toml');
  const policy = /Permissions-Policy\s*=\s*"([^"]*)"/.exec(toml);
  assert.ok(policy, 'netlify.toml must set a Permissions-Policy');
  assert.match(policy[1], /microphone=\(self\)/, 'huddles need microphone=(self)');
  // Narrowest value that works — camera/geolocation must stay off.
  assert.match(policy[1], /camera=\(\)/);
  assert.match(policy[1], /geolocation=\(\)/);

  // The LiveKit client opens a wss:// signalling connection to the LiveKit
  // project's own host. Listed in the report-only CSP now so promoting that
  // policy to enforced later cannot silently kill voice.
  const reportOnly = /Content-Security-Policy-Report-Only\s*=\s*"([^"]*)"/.exec(toml);
  assert.ok(reportOnly, 'netlify.toml must set a report-only CSP');
  assert.match(reportOnly[1], /connect-src[^;]*wss:\/\/\*\.livekit\.cloud/);
});

test('the temporary @livekit/components-react type shim is deleted once the package is installed', () => {
  // src/types/livekit-components-react.d.ts exists ONLY because the huddles
  // worktree could not run `npm install` (node_modules is a symlink into a
  // checkout shared with other agents). An ambient `declare module` WINS over the
  // real package's types, so leaving the shim in place after install would
  // permanently mask the actual API surface — every LiveKit type error would
  // silently disappear. This test is the tripwire.
  const shim = path.join(root, 'src/types/livekit-components-react.d.ts');
  const installed = fs.existsSync(path.join(root, 'node_modules/@livekit/components-react'));
  if (!installed) {
    assert.ok(fs.existsSync(shim), 'the shim is required while the package is not installed');
    return;
  }
  assert.equal(
    fs.existsSync(shim),
    false,
    'npm install has run: delete src/types/livekit-components-react.d.ts and re-run `npm run typecheck` '
    + 'against the REAL @livekit/components-react types.',
  );
});

test('the realtime fanout does not strip huddle fields', () => {
  // sanitizeRealtimeRow only drops declared heavy fields; assert the card's
  // fields survive a broadcast (the "blank column" trap, in its realtime form).
  const row = { id: 'h1', workspace_id: WS, session_id: SESSION, room_name: ROOM, started_by: MEMBER, started_at: 'x', ended_at: null };
  const client = __test.registerTestWebsocketClient({
    userId: MEMBER,
    readyState: 1,
    subscriptions: [{ type: 'db_changes', table: 'huddles', event: '*', schema: 'public', filter: `session_id=eq.${SESSION}` }],
    sent: [],
    send(payload) { this.sent.push(JSON.parse(payload)); },
  });
  __test.notifyDbSubscribers('huddles', 'INSERT', [row]);
  const delivered = client.sent.find((m) => m.type === 'db_changes');
  assert.ok(delivered, 'the huddle row reached the subscriber');
  assert.equal(delivered.table, 'huddles');
  assert.equal(delivered.payload.eventType, 'INSERT');
  assert.deepEqual(delivered.payload.new, row);
});

// ---------------------------------------------------------------------------
// Agents in the huddle
// ---------------------------------------------------------------------------
//
// The agent never touches audio: speech becomes text in the browser and is
// posted as a normal message, and agent messages are read aloud by the browser.
// So the ONLY thing the server contributes is etiquette — telling the agent
// that what it writes is about to be spoken, and that the first sentence must
// leave immediately. Two ways that can be wrong:
//
//   1. it is never added (the feature is inert), or
//   2. it is added to a channel where nobody is in a call (every agent in the
//      workspace suddenly answers in half-sentences).

test('the voice note is added ONLY when a huddle is live for the session', () => {
  const agent = { id: 'a1', name: 'Coder', handle: 'coder' };
  const context = [{ role: 'user', content: '[Jason]: what is the build doing' }];

  const silent = __test.buildDaemonPrompt(context, agent, [], '', false);
  assert.equal(silent.includes('LIVE VOICE HUDDLE'), false, 'a typed channel must not be told to answer aloud');

  const spoken = __test.buildDaemonPrompt(context, agent, [], '', true);
  assert.ok(spoken.includes('LIVE VOICE HUDDLE'));
  // The point of the note. Without "immediately", segmented turns exist but go
  // unused and every reply lands as one six-second block of speech.
  assert.match(spoken, /IMMEDIATELY/);
  assert.match(spoken, /read aloud/i);
  // It has to be read BEFORE the transcript it applies to.
  assert.ok(spoken.indexOf('LIVE VOICE HUDDLE') < spoken.indexOf('Conversation so far:'));
  // Still the same prompt otherwise.
  assert.ok(spoken.includes('[Jason]: what is the build doing'));
  assert.ok(spoken.trimEnd().endsWith('Write your next reply as @coder.'));
});

test('the voice note reaches EVERY run lane, and defaults to off', () => {
  // Three lanes build a daemon prompt (mcp, external, daemon) and the builtin
  // lane appends to the system prompt instead. A note wired into one of them is
  // a feature that works for one kind of agent and silently does not for the
  // others — this repo's most repeated bug shape.
  const source = read('server/index.cjs');
  const calls = source.match(/(?<!function )buildDaemonPrompt\(contextMessages[^)]*\)/g) || [];
  assert.equal(calls.length, 3, 'expected three buildDaemonPrompt call sites');
  for (const call of calls) {
    assert.match(call, /voiceHuddle\)/, `call site does not pass voiceHuddle: ${call}`);
  }
  // The builtin lane, which never builds a daemon prompt.
  assert.match(source, /voiceHuddle && agentContext[\s\S]{0,200}<voice_huddle>/);
  // Derived from the huddles table, not from anything a client sends.
  assert.match(source, /const voiceHuddle = await sessionHasLiveHuddle\(sessionId\)/);
  assert.match(source, /select 1 from huddles where session_id = \$1 and ended_at is null/);
  // Off unless asked for: a caller that forgets the argument must not opt every
  // agent into voice etiquette.
  assert.match(source, /function buildDaemonPrompt\([^)]*voiceHuddle = false\)/);
});
