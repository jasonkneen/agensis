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
// The huddle's OWN conversation session — where the transcript goes. SESSION
// above is the channel it was called from; the two are deliberately different
// everywhere in this file, because conflating them is the bug being prevented.
const TRANSCRIPT = '55555555-5555-4555-8555-555555555555';
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

// The huddle select list. Matched loosely below (`from huddles where …`) rather
// than by full prefix, so ADDING a column to HUDDLE_COLUMNS does not silently
// turn every route test into an "Unexpected SQL" throw — which is exactly what
// happened when transcript_session_id landed.
const HUDDLE_SELECT = /^select .*from huddles where /;

function makeDb({
  roles = {},
  owners = {},
  sessions = { [SESSION]: WS },
  huddleRows = [],
  eventRows = [],
  // Messages already in a huddle's transcript session, keyed by session id.
  // Only the COUNT matters here: it is one half of "did this huddle leave a
  // trace worth marking in the channel".
  transcriptCounts = {},
  // Liveness rows: { huddle_id, identity, connection_epoch, last_seen_at,
  // heartbeat_at, reaped_at }. Modelled for real (not stubbed out) because the
  // reaper now runs on EVERY huddle read — a fake that threw on its SQL would
  // hide the reap behind the route's best-effort catch and every test in this
  // file would pass while the feature did nothing.
  presenceRows = [],
  // Is an agent mid-turn? The reaper asks before ending an empty huddle.
  agentBusy = false,
} = {}) {
  const calls = [];
  const state = {
    huddles: [...huddleRows], events: [...eventRows], messages: [], chatSessions: [],
    presence: presenceRows.map((row) => ({ connection_epoch: '', heartbeat_at: null, reaped_at: null, ...row })),
  };
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
      if (n.startsWith('select id, title from chat_sessions where id = $1 and workspace_id = $2')) {
        return sessions[params[0]] === params[1] ? [{ id: params[0], title: 'general' }] : [];
      }
      if (n.startsWith('select count(*)::int as count from messages where session_id = $1')) {
        return [{ count: Number(transcriptCounts[params[0]] || 0) }];
      }
      if (n.startsWith('insert into chat_sessions')) {
        const [id, workspaceId, title, hostId] = params;
        // The select-into-insert copies from the host; no host row, no session
        // (which is what the real statement does too).
        if (!sessions[hostId]) return [];
        const row = { id, workspace_id: workspaceId, title, folder: 'huddle', host_id: hostId };
        state.chatSessions.push(row);
        return [{ id }];
      }
      if (n.startsWith('insert into messages')) {
        const [sessionId, content, kind, huddleId] = params;
        const row = {
          id: `msg-${state.messages.length + 1}`,
          session_id: sessionId,
          role: 'assistant',
          content,
          message_kind: kind,
          huddle_id: huddleId,
          sender_kind: 'system',
          sender_name: 'Huddle',
          created_at: new Date().toISOString(),
        };
        state.messages.push(row);
        return [row];
      }
      if (HUDDLE_SELECT.test(n) && n.includes('where session_id = $1 and ended_at is null')) {
        return state.huddles.filter((h) => h.session_id === params[0] && !h.ended_at);
      }
      if (HUDDLE_SELECT.test(n) && n.includes('where session_id = $1 order by started_at desc')) {
        return state.huddles.filter((h) => h.session_id === params[0]).slice(-1);
      }
      if (HUDDLE_SELECT.test(n) && n.includes('where id = $1 and workspace_id = $2')) {
        return state.huddles.filter((h) => h.id === params[0] && h.workspace_id === params[1]);
      }
      if (HUDDLE_SELECT.test(n) && n.includes('where room_name = $1')) {
        return state.huddles.filter((h) => h.room_name === params[0]);
      }
      if (n.startsWith('select id, huddle_id, workspace_id, session_id, kind, identity, display_name, event_id, seq, created_at from huddle_events')) {
        return state.events.filter((e) => e.huddle_id === params[0]);
      }
      if (n.startsWith('update huddles set transcript_session_id')) {
        const row = state.huddles.find((h) => h.id === params[1]);
        if (!row) return [];
        row.transcript_session_id = params[0];
        return [row];
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
          transcript_session_id: null,
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
      if (n.startsWith('update huddles set notes = $1')) {
        const [notes, huddleId, workspaceId] = params;
        const row = state.huddles.find((h) => h.id === huddleId && h.workspace_id === workspaceId);
        if (!row) return [];
        row.notes = notes;
        return [row];
      }
      // --- liveness -------------------------------------------------------
      if (n.startsWith('select huddle_id, identity, connection_epoch, last_seen_at, heartbeat_at, reaped_at from huddle_presence')) {
        return state.presence.filter((p) => p.huddle_id === params[0]);
      }
      if (n.startsWith('insert into huddle_presence')) {
        const [huddleId, identity, epoch, beat] = params;
        const now = new Date().toISOString();
        const existing = state.presence.find((p) => p.huddle_id === huddleId && p.identity === identity);
        if (existing) {
          // RETURNING hands back the row AFTER the update, and the real
          // statement never clears reaped_at — which is exactly how the
          // heartbeat learns it was reaped while away.
          existing.connection_epoch = epoch;
          existing.last_seen_at = now;
          if (beat) existing.heartbeat_at = now;
          return [{ ...existing }];
        }
        const row = {
          huddle_id: huddleId, identity, connection_epoch: epoch,
          last_seen_at: now, heartbeat_at: beat ? now : null, reaped_at: null,
        };
        state.presence.push(row);
        return [{ ...row }];
      }
      if (n.startsWith('update huddle_presence set reaped_at = now()')) {
        const row = state.presence.find((p) => p.huddle_id === params[0] && p.identity === params[1]);
        if (row) row.reaped_at = new Date().toISOString();
        return [];
      }
      if (n.startsWith('update huddle_presence set reaped_at = null')) {
        const row = state.presence.find((p) => p.huddle_id === params[0] && p.identity === params[1]);
        if (row) row.reaped_at = null;
        return [];
      }
      if (n.startsWith('delete from huddle_presence where huddle_id = $1 and identity = $2')) {
        state.presence = state.presence.filter((p) => !(p.huddle_id === params[0] && p.identity === params[1]));
        return [];
      }
      if (n.startsWith('delete from huddle_presence where huddle_id = $1')) {
        state.presence = state.presence.filter((p) => p.huddle_id !== params[0]);
        return [];
      }
      if (n.startsWith('select 1 from agent_jobs')) {
        return agentBusy ? [{ ok: 1 }] : [];
      }
      // Nested workspaces: the inherited-role ancestor walk, reached whenever a
      // direct role does not carry the capability — the non-member and
      // viewer-cannot-join cases below.
      if (n.includes('with recursive chain as')) return [];
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
    transcript_session_id: TRANSCRIPT,
    notes: '',
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

// ---------------------------------------------------------------------------
// The huddle's own conversation, and the marker it leaves behind
// ---------------------------------------------------------------------------
//
// The change this section guards: a huddle is ad-hoc, the channel is the
// record. Transcribed speech used to be posted into the host channel as
// ordinary messages, which turned a live call into permanent channel history.
// It now goes into the huddle's OWN session, and the channel gets ONE marker.
//
// Four ways that can be wrong, all of them silent:
//   1. the transcript session is never created (the feature is inert and every
//      utterance falls back into the channel — the old behaviour, shipped as
//      though it were the new one),
//   2. it is created without the host's participants, so @mention dispatch
//      resolves nobody and talking to an agent in a huddle does nothing,
//   3. the marker is never written (a call leaves no trace at all), or
//   4. the marker is written twice, or for a huddle nobody attended.

test('starting a huddle creates its OWN conversation session, linked to the huddle', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' } });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` },
    });
    assert.equal(res.status, 201);
    const body = await res.json();

    // A session of its own, and NOT the channel it was called from. If these
    // are ever equal the transcript is back in the channel.
    const transcriptId = body.data.huddle.transcript_session_id;
    assert.ok(transcriptId, 'the huddle must carry a transcript session');
    assert.notEqual(transcriptId, SESSION);
    assert.equal(body.data.state.transcriptSessionId, transcriptId);

    const created = db.state.chatSessions.find((s) => s.id === transcriptId);
    assert.ok(created, 'the transcript session row was written');
    assert.equal(created.folder, 'huddle', 'folder="huddle" is what keeps it out of the sidebar');
    assert.equal(created.host_id, SESSION, 'it is built from the host session');
  });
});

test('the transcript session copies the host row in SQL, never through a jsonb bind', () => {
  // participants is jsonb, and the two backends bind jsonb OPPOSITELY (postgres
  // takes the object, @netlify/database wants it stringified). A select-into-
  // insert sidesteps the disagreement entirely — and copying participants is
  // not cosmetic: /backend/agents/dispatch resolves @mentions and the DM
  // `direct: true` shortcut from the SESSION's participants, so a transcript
  // session with an empty roster is a room where talking to an agent silently
  // does nothing.
  const source = read('server/huddles.cjs');
  const statement = /insert into chat_sessions[\s\S]*?returning id/.exec(source);
  assert.ok(statement, 'the transcript session insert must exist');
  assert.match(statement[0], /select \$1, \$2, \$3, host\.model/, 'must be a select-into-insert');
  assert.match(statement[0], /host\.participants/, 'participants must be copied from the host');
  assert.match(statement[0], /host\.canvas_id/, 'the project scoping must be copied too');
  assert.match(statement[0], /from chat_sessions host/);
  assert.equal(
    /insert into chat_sessions[\s\S]*?JSON\.stringify/.test(source),
    false,
    'nothing about this insert may stringify a jsonb value',
  );
});

test('an OLD huddle with no transcript session is served, not repaired or crashed', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ transcript_session_id: null })],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();
    // Null, and honestly null. The client falls back to the channel, which is
    // where that huddle's conversation actually happened.
    assert.equal(body.data.state.transcriptSessionId, null);
    // A read must not quietly mint a session for a huddle that ran without one.
    assert.equal(db.state.chatSessions.length, 0);
  });
});

test('a marker is written into the CHANNEL when the huddle ends — one row, not a replay', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()],
    eventRows: [
      { id: 'e1', huddle_id: HUDDLE_ID, workspace_id: WS, session_id: SESSION, kind: 'participant_joined', identity: 'user:a', display_name: 'Ada', event_id: 'lk-1', seq: 1, created_at: new Date(Date.now() - 50_000).toISOString() },
      { id: 'e2', huddle_id: HUDDLE_ID, workspace_id: WS, session_id: SESSION, kind: 'participant_joined', identity: 'user:s', display_name: 'Sam', event_id: 'lk-2', seq: 2, created_at: new Date(Date.now() - 40_000).toISOString() },
    ],
  });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);

    assert.equal(db.state.messages.length, 1, 'exactly one marker, not a transcript replay');
    const marker = db.state.messages[0];
    // In the CHANNEL — the whole point is that the conversation is not here but
    // the record of it is.
    assert.equal(marker.session_id, SESSION);
    assert.equal(marker.message_kind, 'huddle');
    assert.equal(marker.huddle_id, HUDDLE_ID, 'the marker must be able to reopen its transcript');
    assert.equal(marker.sender_kind, 'system');
    assert.match(marker.content, /^You were in a huddle/);
    assert.match(marker.content, /Ada, Sam/);
    assert.ok(marker.content.includes(' · '), 'the duration and roster ride in the sentence itself');
    // Realtime, or the channel shows it only after a reload.
    assert.ok(broadcasts.some((b) => b.table === 'messages' && b.eventType === 'INSERT'));
  });
});

test('ending twice leaves ONE marker (the ended_at guard, not a second mechanism)', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()],
    transcriptCounts: { [TRANSCRIPT]: 4 },
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    assert.equal(db.state.messages.length, 1);
  });
});

test('a huddle nobody joined and nothing was said in leaves NO marker', async () => {
  // A misclick. "You were in a huddle · 0:03 · nobody joined" in the channel
  // for every accidental press is exactly the noise this change removes.
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/end`, { method: 'POST', headers: auth });
    assert.equal(res.status, 200);
    assert.equal(db.state.messages.length, 0);
  });
});

test('a transcript alone is enough to earn a marker, with no webhook joins at all', () => {
  // everJoinedCount is 0 whenever LiveKit's webhook is not configured, so on its
  // own it would suppress the marker for a real, fully-transcribed conversation.
  const ended = { everJoinedCount: 0 };
  assert.equal(huddles.huddleLeftATrace(ended, 0), false);
  assert.equal(huddles.huddleLeftATrace(ended, 3), true);
  assert.equal(huddles.huddleLeftATrace({ everJoinedCount: 2 }, 0), true);
  assert.equal(huddles.huddleLeftATrace(null, 5), false);
});

test('room_finished writes the marker too — both ways a huddle ends leave a record', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()],
    transcriptCounts: { [TRANSCRIPT]: 2 },
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const body = webhookBody({ event: 'room_finished', id: 'lk-finish' });
    const res = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal(res.status, 200);
    assert.equal(db.state.messages.length, 1);
    assert.equal(db.state.messages[0].session_id, SESSION);
    assert.equal(db.state.messages[0].huddle_id, HUDDLE_ID);

    // A redelivery updates zero rows, so it must not collect a second marker.
    const again = webhookBody({ event: 'room_finished', id: 'lk-finish-2' });
    await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: signWebhook(again) },
      body: again,
    });
    assert.equal(db.state.messages.length, 1);
  });
});

test('the marker sentence is truthful, and stands on its own', () => {
  const startedAt = '2026-07-26T10:00:00.000Z';
  const endedAt = '2026-07-26T10:12:04.000Z';
  const ended = { startedAt, endedAt, active: false, everJoinedCount: 2, participants: [] };

  assert.equal(
    huddles.huddleMarkerContent(ended, ['Ada', 'Sam']),
    'You were in a huddle · 12:04 · Ada, Sam',
  );
  // No names delivered (no webhook) — still a true statement about the count.
  assert.equal(
    huddles.huddleMarkerContent(ended, []),
    'You were in a huddle · 12:04 · 2 people joined',
  );
  // Long rosters summarise rather than running off the row.
  assert.match(
    huddles.huddleMarkerContent(ended, ['Ada', 'Sam', 'Kit', 'Lee', 'Max']),
    /Ada, Sam and 3 others$/,
  );
  assert.equal(huddles.huddleMarkerContent(null), '');
});

test('the marker roster comes from the LOG, not from the (empty) live participant list', () => {
  // state.participants is empty for an ended huddle BY DESIGN. Reading it here
  // is how a call four people attended ends up claiming nobody was there.
  const events = [
    { kind: 'participant_joined', identity: 'user:a', display_name: 'Ada', created_at: '2026-07-26T10:01:00.000Z', seq: 1 },
    { kind: 'participant_joined', identity: 'user:s', display_name: 'Sam', created_at: '2026-07-26T10:02:00.000Z', seq: 2 },
    // Left before the end, but was still in the huddle.
    { kind: 'participant_left', identity: 'user:s', display_name: 'Sam', created_at: '2026-07-26T10:03:00.000Z', seq: 3 },
    // A redelivered join must not duplicate the name.
    { kind: 'participant_joined', identity: 'user:a', display_name: 'Ada', created_at: '2026-07-26T10:04:00.000Z', seq: 4 },
    { kind: 'ended', identity: 'user:a', created_at: '2026-07-26T10:05:00.000Z', seq: 5 },
  ];
  assert.deepEqual(huddles.everJoinedNames(events), ['Ada', 'Sam']);

  const state = huddles.foldHuddleState(
    { id: HUDDLE_ID, workspace_id: WS, session_id: SESSION, room_name: ROOM, started_at: '2026-07-26T10:00:00.000Z', ended_at: null },
    events,
  );
  assert.deepEqual(state.participants, [], 'an ended huddle has nobody in it');
  assert.equal(state.everJoinedCount, 2);
  assert.match(huddles.huddleMarkerContent(state, huddles.everJoinedNames(events)), /Ada, Sam$/);
});

test('a marker can reopen its huddle by id, long after the channel has moved on', async () => {
  // The per-channel route answers with the channel's CURRENT huddle, which for
  // a marker written months ago is a completely different call. Without a
  // by-id route "Open transcript" would open the wrong conversation.
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'viewer' },
    huddleRows: [liveHuddleRow({ ended_at: new Date().toISOString() })],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}`, { headers: auth });
    assert.equal(res.status, 200, 'reading a past huddle is a READ — a viewer may');
    const body = await res.json();
    assert.equal(body.data.huddle.id, HUDDLE_ID);
    assert.equal(body.data.state.transcriptSessionId, TRANSCRIPT);

    // And it is still workspace-scoped: no borrowing an id across workspaces.
    const other = await fetch(`${baseUrl}/backend/workspaces/${OTHER_WS}/huddles/${HUDDLE_ID}`, { headers: auth });
    assert.equal(other.status, 403);
  });
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

test('the transcript link and the channel marker are declared in all three schema places', () => {
  // Same rule, second change. transcript_session_id is what moves the huddle
  // conversation out of the channel and messages.huddle_id is what lets the
  // channel point back at it — a fresh DB missing either one silently reverts
  // the whole feature to "type your voice into the channel".
  const runtime = huddles.HUDDLES_SCHEMA_SQL;
  const canonical = read('database/neon-schema.sql');
  const named = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((n) => n.endsWith('_huddle_transcript_sessions.sql'));
  assert.equal(named.length, 1, 'expected exactly one transcript-session migration');
  const migration = read(path.join('supabase/migrations', named[0]));

  for (const [label, source] of [['runtime', runtime], ['neon-schema', canonical], ['migration', migration]]) {
    // ON DELETE SET NULL, never CASCADE: deleting a transcript must not delete
    // the record that the call happened.
    assert.match(
      source,
      /ALTER TABLE huddles ADD COLUMN IF NOT EXISTS transcript_session_id uuid REFERENCES chat_sessions\(id\) ON DELETE SET NULL/,
      label,
    );
    assert.match(source, /ALTER TABLE messages ADD COLUMN IF NOT EXISTS huddle_id uuid/, label);
    assert.match(
      source,
      /CREATE INDEX IF NOT EXISTS idx_messages_huddle ON messages\(huddle_id\) WHERE huddle_id IS NOT NULL/,
      label,
    );
  }
});

test('every huddle read carries transcript_session_id (the blank-column trap)', () => {
  // The routes list huddle columns EXPLICITLY. A column left out of that list
  // reads back as undefined, the client falls through to "no transcript", and
  // speech quietly goes back into the channel — the exact failure this whole
  // change exists to fix, wearing the exact disguise that has hidden it twice
  // before in this repo.
  const source = read('server/huddles.cjs');
  const columns = /const HUDDLE_COLUMNS = '([^']+)'/.exec(source);
  assert.ok(columns, 'HUDDLE_COLUMNS must exist');
  assert.match(columns[1], /\btranscript_session_id\b/);
  // And nothing may select huddles with an ad-hoc list that skips it.
  const selects = source.match(/select [^`;]*from huddles/g) || [];
  for (const statement of selects) {
    assert.ok(
      statement.includes('${HUDDLE_COLUMNS}') || statement.includes('transcript_session_id') || statement.includes('select 1 '),
      `a huddle select bypasses HUDDLE_COLUMNS: ${statement}`,
    );
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
  // Ask the resolver, not the filesystem. A git worktree's own node_modules
  // holds only vite caches — real dependencies resolve upward from the parent
  // checkout — so a `<root>/node_modules/...` path check reads "not installed"
  // in every worktree and demands a shim that has correctly been deleted.
  let installed = true;
  try {
    // The entry point, not `/package.json` — the package's `exports` map does
    // not expose the manifest, so asking for it throws even when installed.
    require.resolve('@livekit/components-react');
  } catch {
    installed = false;
  }
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
  // runAgentTurn moved to server/builtin-turn.cjs (Wave 4 of the index.cjs
  // reduction), and all four lanes went with it. Read the whole Fly lane so
  // this counts call sites wherever they live.
  const source = require('./helpers/fly-lane.cjs').flyLaneSource();
  const calls = source.match(/(?<!function )buildDaemonPrompt\(contextMessages[^)]*\)/g) || [];
  assert.equal(calls.length, 3, 'expected three buildDaemonPrompt call sites');
  for (const call of calls) {
    // Passed, not necessarily LAST: later per-turn notes (the channel intent)
    // are appended after it, and pinning argument position would fail every
    // time a new one lands while the property under test still held.
    assert.match(call, /\bvoiceHuddle\b/, `call site does not pass voiceHuddle: ${call}`);
  }
  // The builtin lane, which never builds a daemon prompt.
  assert.match(source, /voiceHuddle && agentContext[\s\S]{0,200}<voice_huddle>/);
  // Derived from the huddles table, not from anything a client sends.
  assert.match(source, /const voiceHuddle = await sessionHasLiveHuddle\(sessionId\)/);
  // BOTH columns. The agent now answers in the huddle's OWN session, so a
  // lookup that only matched session_id would stop adding the note the moment
  // transcripts moved out of the channel — every reply would come back as one
  // block of prose read out six seconds late, with nothing visibly broken.
  assert.match(
    source,
    /where \(session_id = \$1 or transcript_session_id = \$1\) and ended_at is null/,
    'the voice note must follow the huddle into its own session',
  );
  // Off unless asked for: a caller that forgets the argument must not opt every
  // agent into voice etiquette.
  assert.match(source, /function buildDaemonPrompt\([^)]*voiceHuddle = false[^)]*\)/);
});

// ---------------------------------------------------------------------------
// Self-reported presence. In 48 real huddles the LiveKit webhook (an external
// dashboard step) delivered ZERO participant events, so every roster read
// "Waiting for the first person to connect" while that person was live and
// talking. The client now reports its own join/leave; these pin the contract.

test('confirm records participant_joined for the CALLER identity, deduped per connection', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    for (const epoch of [111, 111, 222]) {
      const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/confirm`, {
        method: 'POST', headers, body: JSON.stringify({ connectionEpoch: epoch }),
      });
      assert.equal(res.status, 200);
    }

    const joins = db.state.events.filter((e) => e.kind === 'participant_joined');
    // Retry of epoch 111 collapses on event_id; the 222 rejoin is a new row.
    assert.equal(joins.length, 2);
    for (const join of joins) {
      assert.equal(join.identity, `user:${MEMBER}`, 'identity comes from the verified session, never the body');
    }
    assert.ok(joins.some((e) => e.event_id === `self:join:user:${MEMBER}:111`));
    assert.ok(joins.some((e) => e.event_id === `self:join:user:${MEMBER}:222`));
  });
});

test('leave records participant_left; a huddle that has ended refuses a confirm', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

    const left = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/leave`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 111 }),
    });
    assert.equal(left.status, 200);
    assert.equal(db.state.events.filter((e) => e.kind === 'participant_left').length, 1);

    db.state.huddles[0].ended_at = new Date().toISOString();
    const confirm = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/confirm`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 333 }),
    });
    assert.equal(confirm.status, 409, 'no joining a huddle that has ended');
  });
});

test('a NON-MEMBER cannot report presence into someone else\'s huddle', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(STRANGER, '1');
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    for (const door of ['confirm', 'leave', 'heartbeat']) {
      const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/${door}`, {
        method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 1 }),
      });
      assert.equal(res.status, 403, door);
    }
    assert.equal(db.state.events.length, 0, 'nothing was recorded');
    assert.equal(db.state.presence.length, 0, 'and no presence was claimed');
  });
});

// ---------------------------------------------------------------------------
// 5. LIVENESS — the reaper
// ---------------------------------------------------------------------------
//
// Self-reported presence has exactly one failure mode, and it is the mirror
// image of the one it fixed: a browser that CRASHES, loses power or is
// force-quit never posts its /leave, so it stays in the roster forever. The
// huddle then shows people who are not there. The LiveKit webhook was the only
// other witness, and the project's webhook has been DELETED — so presence has
// to expire on its own.
//
// The whole decision is two pure functions over timestamps. That is not an
// aesthetic choice: the property that matters most here — "a tab that is merely
// BACKGROUNDED, and therefore throttled to about one timer wake per minute,
// must not be kicked out of a call it is still in" — is a statement about a
// gap, and a gap is not something you can assert about a WHERE clause.

const MINUTE = 60_000;
const ago = (ms) => new Date(Date.now() - ms).toISOString();

const presenceRow = (identity, { heartbeatAgo = null, seenAgo = 0, epoch = '111', reapedAgo = null } = {}) => ({
  huddle_id: HUDDLE_ID,
  identity,
  connection_epoch: epoch,
  last_seen_at: ago(seenAgo),
  heartbeat_at: heartbeatAgo === null ? null : ago(heartbeatAgo),
  reaped_at: reapedAgo === null ? null : ago(reapedAgo),
});

const joinEvent = (identity, name, agoMs, seq) => ({
  id: `e-${identity}-${seq}`, huddle_id: HUDDLE_ID, workspace_id: WS, session_id: SESSION,
  kind: 'participant_joined', identity, display_name: name, event_id: `self:join:${identity}:111`,
  seq, created_at: ago(agoMs),
});

// --- the pure decision ------------------------------------------------------

test('a FRESH heartbeat survives, and a STALE one is reaped', () => {
  const participants = [{ identity: 'user:a' }, { identity: 'user:b' }];
  const nowMs = Date.now();
  const stale = huddles.staleHuddleIdentities({
    participants,
    presence: [
      { identity: 'user:a', heartbeat_at: new Date(nowMs - 10_000).toISOString() },
      { identity: 'user:b', heartbeat_at: new Date(nowMs - 10 * MINUTE).toISOString() },
    ],
    nowMs,
  });
  assert.deepEqual(stale, ['user:b']);
});

test('a BACKGROUNDED tab is not reaped — the gap a throttled timer produces', () => {
  // Chrome clamps a hidden page to roughly ONE timer wake per minute (and
  // Safari/Firefox are comparable), so a participant who alt-tabs away beats at
  // 60s instead of 30s. Reaping that person removes a live human from a call
  // they are still talking in, which is a worse bug than the one being fixed.
  const nowMs = Date.now();
  const gapSurvives = (seconds, label) => {
    const stale = huddles.staleHuddleIdentities({
      participants: [{ identity: 'user:a' }],
      presence: [{ identity: 'user:a', heartbeat_at: new Date(nowMs - seconds * 1000).toISOString() }],
      nowMs,
    });
    assert.deepEqual(stale, [], label);
  };
  gapSurvives(30, 'a normal beat');
  gapSurvives(60, 'one clamped background wake');
  gapSurvives(120, 'TWO consecutive clamped wakes missed');
  gapSurvives(149, 'right up to the threshold');

  // And past it, they go.
  assert.deepEqual(
    huddles.staleHuddleIdentities({
      participants: [{ identity: 'user:a' }],
      presence: [{ identity: 'user:a', heartbeat_at: new Date(nowMs - 151_000).toISOString() }],
      nowMs,
    }),
    ['user:a'],
  );
  // The threshold has to be at least twice the worst-case clamp or the test
  // above is passing by luck.
  assert.ok(huddles.HUDDLE_PRESENCE_STALE_MS >= 2 * MINUTE);
  assert.ok(huddles.HUDDLE_HEARTBEAT_INTERVAL_MS * 4 <= huddles.HUDDLE_PRESENCE_STALE_MS,
    'a foreground tab must get several attempts inside the window');
});

test('a participant this server never heard beat is NEVER reaped', () => {
  const nowMs = Date.now();
  // Two ways to be un-reapable, and both matter:
  //   - no presence row at all: the identity came from LiveKit's webhook, and
  //     the webhook is also what would report its leave.
  //   - a row with no heartbeat: an OLDER FRONTEND, which confirms but does not
  //     beat. Netlify and Fly deploy independently, so between the two deploys
  //     every live participant looks exactly like this. Expiring them would
  //     empty every huddle in the app.
  assert.deepEqual(
    huddles.staleHuddleIdentities({
      participants: [{ identity: 'user:webhook' }, { identity: 'user:old' }],
      presence: [{ identity: 'user:old', last_seen_at: new Date(nowMs - MINUTE).toISOString(), heartbeat_at: null }],
      nowMs,
    }),
    [],
  );
});

test('an EMPTY huddle ends — but not while anything is still happening in it', () => {
  const nowMs = Date.now();
  const base = { participantCount: 0, lastActivityAtMs: nowMs - 10 * MINUTE, nowMs };

  assert.equal(huddles.shouldEndEmptyHuddle(base), true, 'nobody here, nothing happening');
  assert.equal(
    huddles.shouldEndEmptyHuddle({ ...base, participantCount: 1 }),
    false,
    'somebody is in it',
  );
  assert.equal(
    huddles.shouldEndEmptyHuddle({ ...base, agentBusy: true }),
    false,
    'an agent mid-turn is still writing into this huddle',
  );
  assert.equal(
    huddles.shouldEndEmptyHuddle({ ...base, lastActivityAtMs: nowMs - 20_000 }),
    false,
    'inside the grace: somebody may be reconnecting',
  );
  assert.equal(
    huddles.shouldEndEmptyHuddle({ ...base, lastActivityAtMs: 0 }),
    false,
    'a huddle we cannot put a clock on is never guessed at',
  );
  // A brand-new huddle has a roster of nobody until the first confirm lands.
  // Without the grace, creating one would end it on the very next read.
  assert.equal(
    huddles.shouldEndEmptyHuddle({ participantCount: 0, lastActivityAtMs: nowMs, nowMs }),
    false,
    'a huddle that started a moment ago must survive its own first read',
  );
});

test('the activity clock reads the LATEST of start, events and presence', () => {
  const started = '2026-07-26T10:00:00.000Z';
  const huddle = { started_at: started };
  assert.equal(huddles.huddleLastActivityAt(huddle, [], []), Date.parse(started));
  assert.equal(
    huddles.huddleLastActivityAt(huddle, [{ created_at: '2026-07-26T10:05:00.000Z' }], []),
    Date.parse('2026-07-26T10:05:00.000Z'),
  );
  assert.equal(
    huddles.huddleLastActivityAt(
      huddle,
      [{ created_at: '2026-07-26T10:05:00.000Z' }],
      [{ last_seen_at: '2026-07-26T10:09:00.000Z', heartbeat_at: '2026-07-26T10:08:00.000Z' }],
    ),
    Date.parse('2026-07-26T10:09:00.000Z'),
  );
});

// --- the reap, through the routes -------------------------------------------

test('reading a huddle reaps the crashed browser and leaves the live one alone', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()],
    eventRows: [joinEvent('user:a', 'Ada', 5 * MINUTE, 1), joinEvent('user:b', 'Sam', 5 * MINUTE, 2)],
    // Ada's laptop was force-quit four minutes ago; Sam is still talking.
    presenceRows: [
      presenceRow('user:a', { heartbeatAgo: 4 * MINUTE, seenAgo: 4 * MINUTE }),
      presenceRow('user:b', { heartbeatAgo: 5_000, seenAgo: 5_000, epoch: '222' }),
    ],
  });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();

    // The roster the client is handed has already had the ghost removed —
    // there is no window in which this route returns someone it knows is gone.
    assert.deepEqual(body.data.state.participants.map((p) => p.identity), ['user:b']);
    assert.equal(body.data.state.active, true, 'somebody is still in it');

    const left = db.state.events.filter((e) => e.kind === 'participant_left');
    assert.equal(left.length, 1);
    assert.equal(left[0].identity, 'user:a');
    assert.equal(left[0].display_name, 'Ada', 'the leave carries the name the join did');
    // Namespaced and deterministic: a retry, or a second Fly machine reaping the
    // same huddle at the same moment, collapses onto this one row.
    assert.equal(left[0].event_id, 'reap:leave:user:a:111');
    // And it can never collide with the browser's own leave for that connection.
    assert.notEqual(left[0].event_id, 'self:leave:user:a:111');

    // Live, so the card corrects itself without a refetch.
    assert.ok(broadcasts.some((b) => b.table === 'huddle_events' && b.eventType === 'INSERT'));
    // Marked, so the reaped browser's next heartbeat knows to re-announce.
    assert.ok(db.state.presence.find((p) => p.identity === 'user:a').reaped_at);
    assert.equal(db.state.presence.find((p) => p.identity === 'user:b').reaped_at, null);
  });
});

test('a huddle whose every participant was reaped ENDS, and leaves its marker', async () => {
  const rooms = [];
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ started_at: ago(20 * MINUTE) })],
    eventRows: [joinEvent('user:a', 'Ada', 19 * MINUTE, 1)],
    presenceRows: [presenceRow('user:a', { heartbeatAgo: 6 * MINUTE, seenAgo: 6 * MINUTE })],
  });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db, { endRoom: async (name) => { rooms.push(name); return true; } });
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.data.state.active, false, 'a room nobody is in must not stay live forever');
    assert.equal(body.data.state.participantCount, 0);
    assert.ok(db.state.huddles[0].ended_at);

    // The same record every other way of ending leaves — one marker, in the
    // CHANNEL, able to reopen the transcript.
    assert.equal(db.state.messages.length, 1);
    assert.equal(db.state.messages[0].session_id, SESSION);
    assert.equal(db.state.messages[0].huddle_id, HUDDLE_ID);
    assert.match(db.state.messages[0].content, /^You were in a huddle/);
    // Stragglers are disconnected rather than left talking into a room the app
    // considers closed.
    assert.deepEqual(rooms, [ROOM]);
    // Presence for an ended huddle is not kept: the table means "who is in a
    // call right now"; who was ever in it is the event log's job.
    assert.equal(db.state.presence.length, 0);
    assert.ok(broadcasts.some((b) => b.table === 'huddles' && b.eventType === 'UPDATE'));

    // Idempotent: a second read must not end it again or write a second marker.
    await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(db.state.messages.length, 1);
  });
});

test('an empty huddle does NOT end while an agent is mid-turn', async () => {
  // The reap has removed everybody, but an agent is still writing into the
  // huddle's transcript. Ending the room here files the marker before the
  // answer arrives, and the human comes back to a call that closed itself
  // mid-sentence.
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ started_at: ago(20 * MINUTE) })],
    eventRows: [joinEvent('user:a', 'Ada', 19 * MINUTE, 1)],
    presenceRows: [presenceRow('user:a', { heartbeatAgo: 6 * MINUTE, seenAgo: 6 * MINUTE })],
    agentBusy: true,
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    const body = await res.json();
    // The ghost still goes — that part is not in question.
    assert.equal(body.data.state.participantCount, 0);
    assert.equal(body.data.state.active, true, 'the huddle stays open for the agent');
    assert.equal(db.state.huddles[0].ended_at, null);
    assert.equal(db.state.messages.length, 0);
  });
});

test('pressing Huddle on a channel full of crashed browsers opens a NEW one', async () => {
  // The failure this prevents: the unique index allows ONE live huddle per
  // channel, so a huddle nobody is in still holds the slot. Without the reap on
  // this path the button would enrol you in the wake instead of starting a call.
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ started_at: ago(30 * MINUTE) })],
    eventRows: [joinEvent('user:a', 'Ada', 29 * MINUTE, 1)],
    presenceRows: [presenceRow('user:a', { heartbeatAgo: 10 * MINUTE, seenAgo: 10 * MINUTE })],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, {
      method: 'POST', headers: auth,
    });
    assert.equal(res.status, 201, 'a new huddle, not a seat in the old one');
    const body = await res.json();
    assert.equal(body.data.created, true);
    assert.notEqual(body.data.huddle.id, HUDDLE_ID);
    assert.equal(body.data.state.participantCount, 0, 'and it starts empty, not haunted');
    // The old one was closed rather than left holding the one-live-per-session
    // slot — which is also what stops the insert above hitting the index.
    assert.ok(db.state.huddles.find((h) => h.id === HUDDLE_ID).ended_at);
    assert.equal(db.state.huddles.filter((h) => !h.ended_at).length, 1);
    // The client is told how often to report, by the server, so the window and
    // the threshold it is measured against can only change together.
    assert.equal(body.data.heartbeatIntervalMs, huddles.HUDDLE_HEARTBEAT_INTERVAL_MS);
  });
});

test('joining by id refuses a huddle whose occupants all crashed', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ started_at: ago(30 * MINUTE) })],
    eventRows: [joinEvent('user:a', 'Ada', 29 * MINUTE, 1)],
    presenceRows: [presenceRow('user:a', { heartbeatAgo: 10 * MINUTE, seenAgo: 10 * MINUTE })],
  });
  __test.setTestDb(db);
  const { app, minted } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/join`, {
      method: 'POST', headers: auth,
    });
    assert.equal(res.status, 409, 'truthful: that call is over');
    assert.equal(minted.length, 0, 'and no credential for a dead room');
  });
});

test('confirm clears ghosts but never ends the huddle — somebody is arriving', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ started_at: ago(30 * MINUTE) })],
    eventRows: [joinEvent('user:a', 'Ada', 29 * MINUTE, 1)],
    presenceRows: [presenceRow('user:a', { heartbeatAgo: 10 * MINUTE, seenAgo: 10 * MINUTE })],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const headers = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}`, 'Content-Type': 'application/json' };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/confirm`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 777 }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The ghost is gone and the arriving member is in — a roster of exactly the
    // people who are actually there.
    assert.deepEqual(body.data.state.participants.map((p) => p.identity), [`user:${MEMBER}`]);
    assert.equal(db.state.huddles[0].ended_at, null, 'ending a huddle somebody is joining is absurd');

    // Confirm seeds the liveness row but does NOT claim a heartbeat: nothing is
    // reapable until the browser actually starts beating.
    const row = db.state.presence.find((p) => p.identity === `user:${MEMBER}`);
    assert.ok(row, 'the join is on a clock now');
    assert.equal(row.heartbeat_at, null);
    assert.equal(row.connection_epoch, '777');
  });
});

// --- the heartbeat ----------------------------------------------------------

test('a heartbeat refreshes THIS caller only, and is refused by an ended huddle', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const headers = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}`, 'Content-Type': 'application/json' };

    const beat = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 111, identity: 'user:someone-else' }),
    });
    assert.equal(beat.status, 200);
    assert.deepEqual(await beat.json(), {
      data: { ok: true, rejoined: false, heartbeatIntervalMs: huddles.HUDDLE_HEARTBEAT_INTERVAL_MS },
      error: null,
    });

    assert.equal(db.state.presence.length, 1);
    // The body named someone else. Identity comes from the verified session and
    // nowhere else — a client may only ever speak about ITSELF.
    assert.equal(db.state.presence[0].identity, `user:${MEMBER}`);
    assert.ok(db.state.presence[0].heartbeat_at, 'beating is what opts you into being reaped');

    // A beat is bookkeeping. It must not write an event or wake every client in
    // the channel N times a minute.
    assert.equal(db.state.events.length, 0);
    assert.equal(broadcasts.length, 0);

    // Repeats stay one row.
    await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 111 }),
    });
    assert.equal(db.state.presence.length, 1);

    db.state.huddles[0].ended_at = new Date().toISOString();
    const dead = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 111 }),
    });
    // The 409 is load-bearing: it is how a browser whose websocket died learns
    // the call is over and stops beating at it.
    assert.equal(dead.status, 409);
  });
});

test('a browser that was reaped while away is put BACK on the roster by its next beat', async () => {
  // The flaky-connection case. Under the threshold nothing happens at all; over
  // it the participant is expired, and this is what stops them being live in the
  // room and invisible on the card when they come back.
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()],
    eventRows: [joinEvent(`user:${MEMBER}`, 'Member', 10 * MINUTE, 1)],
    presenceRows: [presenceRow(`user:${MEMBER}`, { heartbeatAgo: 6 * MINUTE, seenAgo: 6 * MINUTE, reapedAgo: MINUTE })],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const headers = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}`, 'Content-Type': 'application/json' };
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 111 }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.rejoined, true);

    const joins = db.state.events.filter((e) => e.kind === 'participant_joined');
    assert.equal(joins.length, 2, 'the original join, plus the re-announcement');
    assert.match(joins[1].event_id, /^reap:rejoin:user:user-member:/);
    assert.equal(db.state.presence[0].reaped_at, null, 'and the flag is cleared, so it happens once');

    // A retry of the same beat must not announce a second time.
    await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/heartbeat`, {
      method: 'POST', headers, body: JSON.stringify({ connectionEpoch: 111 }),
    });
    assert.equal(db.state.events.filter((e) => e.kind === 'participant_joined').length, 2);
  });
});

// --- the webhook, if it is ever switched back on ----------------------------

test('a LATE webhook event cannot resurrect a reaped participant or double-count a join', async () => {
  // The webhook path is deliberately still here and still honoured. What must
  // NOT happen is a participant_joined that LiveKit sent before the reap
  // arriving after it and putting the ghost back: the fold sorts by the event's
  // OWN timestamp, not by arrival order, so a join that happened before the
  // leave stays before the leave no matter when it is delivered.
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()],
    eventRows: [joinEvent('user:a', 'Ada', 10 * MINUTE, 1), joinEvent('user:b', 'Sam', 10 * MINUTE, 2)],
    presenceRows: [
      presenceRow('user:a', { heartbeatAgo: 6 * MINUTE, seenAgo: 6 * MINUTE }),
      presenceRow('user:b', { heartbeatAgo: 2_000, seenAgo: 2_000, epoch: '222' }),
    ],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const auth = { Authorization: `Bearer ${await __test.issueToken(MEMBER, '1')}` };
    await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal(db.state.events.filter((e) => e.kind === 'participant_left').length, 1);

    // LiveKit finally delivers Ada's join, timestamped when it actually
    // happened — five minutes before the reap.
    const body = webhookBody({
      event: 'participant_joined',
      participant: { identity: 'user:a', name: 'Ada' },
      id: 'lk-late-join',
      createdAt: Math.floor((Date.now() - 5 * MINUTE) / 1000),
    });
    const hook = await fetch(`${baseUrl}/backend/livekit-webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: signWebhook(body) },
      body,
    });
    assert.equal(hook.status, 200);

    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    const state = (await res.json()).data.state;
    assert.deepEqual(state.participants.map((p) => p.identity), ['user:b'], 'no resurrection');
    // everJoined is a set of identities, so a second join for Ada is not a
    // second person — the marker's "2 people joined" stays true.
    assert.equal(state.everJoinedCount, 2);
    assert.equal(state.peakParticipants, 2);
  });
});

test('a reaped participant who genuinely comes back through LiveKit is present again', () => {
  // The mirror of the test above, and the reason the fix is "sort by timestamp"
  // rather than "ignore late joins": a join that really did happen AFTER the
  // reap is a real rejoin and must show.
  const state = huddles.foldHuddleState(liveHuddleRow(), [
    ev('participant_joined', 'user:a', '2026-07-26T10:00:00.000Z', { seq: 1 }),
    ev('participant_left', 'user:a', '2026-07-26T10:05:00.000Z', { seq: 2, event_id: 'reap:leave:user:a:111' }),
    ev('participant_joined', 'user:a', '2026-07-26T10:06:00.000Z', { seq: 3 }),
  ]);
  assert.deepEqual(state.participants.map((p) => p.identity), ['user:a']);
  assert.equal(state.everJoinedCount, 1, 'one person, twice — not two people');
});

// --- schema -----------------------------------------------------------------

test('huddle_presence is declared in all three schema places', () => {
  const runtime = huddles.HUDDLES_SCHEMA_SQL;
  const canonical = read('database/neon-schema.sql');
  const named = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((n) => n.endsWith('_huddle_presence.sql'));
  assert.equal(named.length, 1, 'expected exactly one huddle-presence migration');
  const migration = read(path.join('supabase/migrations', named[0]));

  for (const [label, source] of [['runtime', runtime], ['neon-schema', canonical], ['migration', migration]]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS huddle_presence \(/, label);
    // CASCADE: liveness for a huddle that no longer exists is meaningless.
    assert.match(source, /huddle_id uuid NOT NULL REFERENCES huddles\(id\) ON DELETE CASCADE/, label);
    // One row per person per huddle — the whole point of not putting this in
    // the append-only log.
    assert.match(source, /PRIMARY KEY \(huddle_id, identity\)/, label);
    assert.match(source, /last_seen_at timestamptz NOT NULL DEFAULT now\(\)/, label);
    // NULLABLE, and the reaper keys on it alone: a client that confirms but
    // never beats is an older frontend, and Netlify deploys separately from Fly.
    assert.match(source, /heartbeat_at timestamptz(?!\s+NOT NULL)/, label);
    assert.match(source, /reaped_at timestamptz(?!\s+NOT NULL)/, label);
  }

  // Some tables are FOUR-place: netlify/functions/backend.mjs carries its own
  // bootstrap DDL. Huddles are not — they need the websocket fanout, so the
  // Netlify mirror has no huddle routes and no huddle SQL, only a comment
  // saying why. Pinned, because the day huddles do land there this is the place
  // the presence table would be forgotten.
  const netlify = read('netlify/functions/backend.mjs');
  assert.equal(/huddle_presence/.test(netlify), false);
  assert.equal(/(from|into|table)\s+huddles?\b/i.test(netlify), false,
    'huddle SQL reached the Netlify mirror: huddle_presence needs its bootstrap DDL there too');
});

test('presence is server-owned: no client may read or write it through /backend/db', () => {
  // huddles and huddle_events are readable (the card folds them). Presence is
  // not: it is liveness bookkeeping, and a browser that could write it could
  // keep a ghost alive forever — which is the exact bug being fixed.
  assert.equal(core.ALLOWED_TABLES.has('huddle_presence'), false);
  assert.equal(core.DB_TABLE_ACCESS.huddle_presence, undefined);
});

test('the liveness decision is a PURE function, not a WHERE clause', () => {
  // A rule buried in SQL cannot be asserted against a backgrounded-tab-length
  // gap, and that gap is the property most likely to be got wrong. If someone
  // later moves the comparison into the query, these tests keep passing while
  // the shipped behaviour drifts — so pin it.
  const source = read('server/huddles.cjs');
  assert.equal(typeof huddles.staleHuddleIdentities, 'function');
  assert.equal(typeof huddles.shouldEndEmptyHuddle, 'function');
  assert.equal(
    /huddle_presence[\s\S]{0,300}now\(\)\s*-\s*interval/.test(source),
    false,
    'presence staleness must not be decided inside a query',
  );
});

// --- 5. notes ----------------------------------------------------------------
//
// Shared call notes. Deliberately gated at 'write' (posting-in-the-channel
// strength), NOT the 'manage' the generic /backend/db path enforces for this
// table — huddles rows also carry LiveKit/webhook authority an editor must
// never touch, which is why that path stays locked down. Notes are just text;
// anyone who could speak in the call should be able to jot them.

test('notes: unauthenticated is rejected and nothing is written', async () => {
  const db = makeDb({ huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes: 'hi' }),
    });
    assert.equal(res.status, 401);
    assert.equal(db.state.huddles[0].notes, '');
    assert.equal(broadcasts.length, 0);
  });
});

test('notes: a non-member is rejected 403, a viewer (read-only) too', async () => {
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor', [`${WS}:${VIEWER}`]: 'viewer' },
    huddleRows: [liveHuddleRow()],
  });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    for (const userId of [STRANGER, VIEWER]) {
      const token = await __test.issueToken(userId, '1');
      const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ notes: 'sneaky' }),
      });
      assert.equal(res.status, 403, `expected 403 for ${userId}`);
    }
    assert.equal(db.state.huddles[0].notes, '');
    assert.equal(broadcasts.length, 0);
  });
});

test('notes: an editor (write capability) can save them, and it broadcasts', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app, broadcasts } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notes: 'Bring the deck next time.' }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.data.huddle.notes, 'Bring the deck next time.');
    assert.equal(db.state.huddles[0].notes, 'Bring the deck next time.');
    // Live for every OTHER viewer of the call: the same fanout every other
    // huddle mutation broadcasts through, so the Notes tab updates the same
    // way join/leave/end already do — no bespoke channel to get wrong.
    assert.equal(broadcasts.length, 1);
    assert.deepEqual(broadcasts[0].table, 'huddles');
    assert.equal(broadcasts[0].eventType, 'UPDATE');
  });
});

test('notes: a commenter (comment capability, not write) is turned away today', async () => {
  // Pinning the ACTUAL rule rather than assuming: a commenter role carries
  // 'read' + 'comment', not 'write', so this route currently refuses them even
  // though they could speak in the call itself. If that gap is ever closed
  // deliberately, this test is the one that has to change with it — not
  // silently start failing somewhere else.
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'commenter' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notes: 'hi' }),
    });
    assert.equal(res.status, 403);
  });
});

test('notes: a huddle from another workspace 404s rather than leaking', async () => {
  const db = makeDb({
    roles: { [`${OTHER_WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow()], // lives in WS, not OTHER_WS
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${OTHER_WS}/huddles/${HUDDLE_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notes: 'hi' }),
    });
    assert.equal(res.status, 404);
    assert.equal(db.state.huddles[0].notes, '');
  });
});

test('notes: a huge payload is rejected rather than parked on the row', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow()] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notes: 'x'.repeat(huddles.NOTES_MAX_LENGTH + 1) }),
    });
    assert.equal(res.status, 400);
    assert.equal(db.state.huddles[0].notes, '');
  });
});

test('notes: clearing them back to empty is allowed (not treated as "no change")', async () => {
  const db = makeDb({ roles: { [`${WS}:${MEMBER}`]: 'editor' }, huddleRows: [liveHuddleRow({ notes: 'old note' })] });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const res = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ notes: '' }),
    });
    assert.equal(res.status, 200);
    assert.equal(db.state.huddles[0].notes, '');
  });
});

test('every huddle response carries notes (read routes were not left behind)', async () => {
  // The exact "blank-column trap" the transcript_session_id test above guards
  // against, for the newer column: every read route uses HUDDLE_COLUMNS, so
  // this is really a HUDDLE_COLUMNS assertion, pinned via the actual response.
  const db = makeDb({
    roles: { [`${WS}:${MEMBER}`]: 'editor' },
    huddleRows: [liveHuddleRow({ notes: 'agenda: ship it' })],
  });
  __test.setTestDb(db);
  const { app } = makeApp(db);
  await withServer(app, async (baseUrl) => {
    const token = await __test.issueToken(MEMBER, '1');
    const auth = { Authorization: `Bearer ${token}` };
    const bySession = await fetch(`${baseUrl}/backend/workspaces/${WS}/sessions/${SESSION}/huddle`, { headers: auth });
    assert.equal((await bySession.json()).data.huddle.notes, 'agenda: ship it');
    const byId = await fetch(`${baseUrl}/backend/workspaces/${WS}/huddles/${HUDDLE_ID}`, { headers: auth });
    assert.equal((await byId.json()).data.huddle.notes, 'agenda: ship it');
  });
});

test('huddles.notes is declared in all three schema places', () => {
  const runtime = huddles.HUDDLES_SCHEMA_SQL;
  const canonical = read('database/neon-schema.sql');
  const named = fs.readdirSync(path.join(root, 'supabase/migrations')).filter((n) => n.endsWith('_huddle_notes.sql'));
  assert.equal(named.length, 1, 'expected exactly one huddle-notes migration');
  const migration = read(path.join('supabase/migrations', named[0]));

  for (const [label, source] of [['runtime', runtime], ['neon-schema', canonical], ['migration', migration]]) {
    assert.match(source, /ALTER TABLE huddles ADD COLUMN IF NOT EXISTS notes text NOT NULL DEFAULT ''/, label);
  }
});

test('notes stay off the generic /backend/db path — huddles writes are manage-only there', () => {
  // The whole reason this is its own route: DB_TABLE_ACCESS.huddles.update is
  // 'manage', not 'write', so an editor reaching /backend/db/update for this
  // table is refused before a single column is inspected. If this ever
  // silently loosened to 'write', an editor could rewrite room_name/started_by
  // — the LiveKit-authority fields the dedicated routes exist to protect.
  assert.equal(core.DB_TABLE_ACCESS.huddles.update, 'manage');
  assert.equal(core.ALLOWED_TABLES.has('huddles'), true);
});
