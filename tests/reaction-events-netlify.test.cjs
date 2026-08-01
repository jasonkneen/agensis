'use strict';

// ============================================================================
// tests/reaction-events-netlify.test.cjs
// ----------------------------------------------------------------------------
// The other lane. `netlify/functions/backend.mjs` serves the same
// POST /backend/messages/:id/reactions route over the same Neon DB, so a
// reaction CAN be written there — and "wired into one backend, silently missing
// from the other" is this repo's most repeated bug. Both lanes queue into the
// same `flow_webhook_deliveries` table; the Fly server's worker drains it.
//
// The route moved (it used to be the generic /backend/db/update carrying a whole
// caller-authored map, which raced and had forgeable attribution). The contract
// these tests pin did not: an event is still the diff of a before-map against an
// after-map, and emission is still idempotent.
//
// The one thing that is deliberately NOT shared is the jsonb bind: porsager (Fly)
// needs the OBJECT, @netlify/database needs the STRING. Unifying them corrupts
// one lane or the other, so this file pins THIS lane's half of that contract.
//
// `@netlify/database` is mocked at the module level before backend.mjs is first
// imported (ESM mocks must be installed first), exactly as
// tests/netlify-parity.test.cjs does — there is no live Postgres here.
// ============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  REACTION_CREATED,
  REACTION_REMOVED,
} = require('../shared/reaction-events.cjs');

const AUTH_SECRET = 'netlify-reaction-test-secret';
const USER = 'user-1';
const WORKSPACE = 'w1';
const OTHER_WORKSPACE = 'w2';
const SESSION = 'chan-1';
const MESSAGE = 'msg-1';

let handler;
let state;

// The row shape the RETURNING list produces, so both the toggle statements and
// the no-op re-read answer with the same columns the event builder reads.
function messageRowFor(reactions) {
  return {
    id: MESSAGE,
    session_id: SESSION,
    reactions,
    sender_kind: 'agent',
    sender_id: 'agent-7',
    sender_name: 'Coder',
    thread_parent_id: null,
    created_at: '2026-07-01T00:00:00.000Z',
  };
}

function resetState(overrides = {}) {
  state = {
    reactions: {},
    connections: [{ id: 'conn-1', workspace_id: WORKSPACE, channel_id: null, events: [REACTION_CREATED, REACTION_REMOVED] }],
    deliveries: [],
    messageUpdates: [],
    failDeliveryInsert: false,
    ...overrides,
  };
  return state;
}

test.before(async () => {
  delete process.env.AGENSIS_AUTH_SECRET;
  process.env.AUTH_SECRET = AUTH_SECRET;
  resetState();
  mock.module('@netlify/database', {
    namedExports: {
      getDatabase: () => ({
        pool: {
          async query(text, params = []) {
            const n = String(text).replace(/\s+/g, ' ').trim();
            const q = n.toLowerCase();
            if (['begin', 'commit', 'rollback'].includes(q)) return { rows: [] };
            if (q.startsWith('alter table') || q.startsWith('create table') || q.startsWith('create index')) {
              return { rows: [] };
            }
            if (/select token_version from app_users/i.test(n)) return { rows: [{ token_version: '1' }] };
            if (q.startsWith('select 1 from workspaces where id')) {
              return { rows: String(params[1]) === USER ? [{ ok: 1 }] : [] };
            }
            if (q.startsWith('select role from workspace_members')) return { rows: [] };
            if (q.startsWith('select workspace_id') && q.includes('from chat_sessions')) {
              return { rows: String(params[0]) === SESSION ? [{ workspace_id: WORKSPACE }] : [] };
            }
            if (q.startsWith('select id, workspace_id from chat_sessions where id')) {
              return { rows: String(params[0]) === SESSION ? [{ id: SESSION, workspace_id: WORKSPACE }] : [] };
            }
            if (q.startsWith('select id, visibility, folder, deleted_at from chat_sessions where id')) {
              return {
                rows: String(params[0]) === SESSION
                  ? [{ id: SESSION, visibility: 'workspace', folder: 'Channels', deleted_at: null }]
                  : [],
              };
            }
            if (q.startsWith('select role, sender_kind, sender_id from messages')) {
              return {
                rows: String(params[0]) === MESSAGE && String(params[1]) === SESSION
                  ? [{ role: 'user', sender_kind: 'user', sender_id: USER }]
                  : [],
              };
            }
            // The reaction route's message lookup, then the session it resolves
            // both gates against. A plain channel, so the DM gate returns at once.
            if (q.startsWith('select m.id, m.session_id from messages m')) {
              return { rows: String(params[0]) === MESSAGE ? [{ id: MESSAGE, session_id: SESSION }] : [] };
            }
            if (q.startsWith('select id, workspace_id, visibility, folder, parent_message_id, split_parent_id, deleted_at from chat_sessions')) {
              return {
                rows: String(params[0]) === SESSION
                  ? [{
                    id: SESSION,
                    workspace_id: WORKSPACE,
                    visibility: 'workspace',
                    folder: 'General',
                    parent_message_id: null,
                    split_parent_id: null,
                    deleted_at: null,
                  }]
                  : [],
              };
            }
            // The two atomic toggle statements. This mock stands in for POSTGRES
            // — it applies the jsonb semantics including the guards that make a
            // repeat click a no-op. It stands in for no authorization rule.
            if (q.startsWith('update messages set reactions = jsonb_set')) {
              const [id, sessionId, reaction, userId] = params.map(String);
              if (id !== MESSAGE || sessionId !== SESSION) return { rows: [] };
              const holders = state.reactions[reaction] || [];
              if (holders.includes(userId)) return { rows: [] };
              if (!(reaction in state.reactions) && Object.keys(state.reactions).length >= 24) return { rows: [] };
              state.reactions = { ...state.reactions, [reaction]: [...holders, userId] };
              state.messageUpdates.push({ sql: n, params });
              return { rows: [messageRowFor(state.reactions)] };
            }
            if (q.startsWith('update messages set reactions = case')) {
              const [id, sessionId, reaction, userId] = params.map(String);
              if (id !== MESSAGE || sessionId !== SESSION) return { rows: [] };
              const holders = state.reactions[reaction] || [];
              if (!holders.includes(userId)) return { rows: [] };
              const next = { ...state.reactions };
              const remaining = holders.filter(user => user !== userId);
              if (remaining.length === 0) delete next[reaction];
              else next[reaction] = remaining;
              state.reactions = next;
              state.messageUpdates.push({ sql: n, params });
              return { rows: [messageRowFor(state.reactions)] };
            }
            if (q.startsWith('select id, session_id, reactions, sender_kind')) {
              return {
                rows: [{
                  id: MESSAGE,
                  session_id: SESSION,
                  reactions: state.reactions,
                  sender_kind: 'agent',
                  sender_id: 'agent-7',
                  sender_name: 'Coder',
                  thread_parent_id: null,
                  created_at: '2026-07-01T00:00:00.000Z',
                  content: 'the secret contents of this message',
                }],
              };
            }
            if (q.startsWith('update "messages" set')) {
              state.messageUpdates.push({ sql: n, params });
              // The Netlify lane stringifies a jsonb bind; reflect what landed.
              if (q.includes('"reactions" =')) {
                state.reactions = typeof params[0] === 'string' ? JSON.parse(params[0]) : params[0];
              }
              return {
                rows: [{
                  id: MESSAGE,
                  session_id: SESSION,
                  reactions: state.reactions,
                  __integrity_id: MESSAGE,
                  __integrity_session_id: SESSION,
                }],
              };
            }
            if (q.startsWith('update activity_events')) return { rows: [] };
            if (q.startsWith('select id, channel_id, events from flow_connections')) {
              return { rows: state.connections.filter(c => String(c.workspace_id) === String(params[0])) };
            }
            if (q.startsWith('insert into flow_webhook_deliveries')) {
              if (state.failDeliveryInsert) throw new Error('deliveries table is unavailable');
              state.deliveries.push({
                connectionId: params[0],
                workspaceId: params[1],
                eventId: params[2],
                eventType: params[3],
                payload: params[4],
              });
              return { rows: [] };
            }
            throw new Error(`Unexpected DB query in the netlify reaction test: ${n}`);
          },
          async connect() {
            return {
              query: (text, params = []) => this.query(text, params),
              release() {},
            };
          },
        },
      }),
    },
  });
  const backend = await import(pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href);
  handler = backend.default;
});

function issueToken(userId = USER, tokenVersion = '1') {
  const payload = `${userId}.${tokenVersion}.${Math.floor(Date.now() / 1000)}`;
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

// ONE reaction, ONE operation, and the reactor is never named in the body.
async function react(reaction, op = 'add') {
  return handler(new Request(`http://localhost/backend/messages/${MESSAGE}/reactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${issueToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ reaction, op }),
  }));
}

test('the Netlify lane queues a reaction event too, with the payload bound as a STRING', async () => {
  resetState();
  const res = await react('✅', 'add');
  assert.equal(res.status, 200, 'the reaction is saved');

  assert.equal(state.deliveries.length, 1, 'exactly one delivery');
  const [delivery] = state.deliveries;
  assert.equal(delivery.eventType, REACTION_CREATED);
  assert.equal(delivery.workspaceId, WORKSPACE);
  assert.equal(
    typeof delivery.payload,
    'string',
    '@netlify/database REQUIRES the stringified form — the opposite of the Fly lane',
  );

  const payload = JSON.parse(delivery.payload);
  assert.equal(payload.type, REACTION_CREATED);
  assert.equal(payload.workspaceId, WORKSPACE);
  assert.equal(payload.channelId, SESSION);
  assert.deepEqual(payload.data, {
    messageId: MESSAGE,
    reaction: '✅',
    userId: USER,
    actorUserId: USER,
    count: 1,
    messageSenderKind: 'agent',
    messageSenderId: 'agent-7',
    messageSenderName: 'Coder',
    messageThreadParentId: null,
    messageCreatedAt: '2026-07-01T00:00:00.000Z',
  });
  assert.ok(
    !delivery.payload.includes('the secret contents'),
    'a reaction event is a signal, not a content export',
  );
});

test('the Netlify lane does not emit twice for the same reaction, and emits removal', async () => {
  resetState();
  assert.equal((await react('✅', 'add')).status, 200);
  assert.equal((await react('✅', 'add')).status, 200);
  assert.equal(state.deliveries.length, 1, 'the second request is not a change');
  // STRONGER than the whole-map path this replaced, where both writes landed and
  // only the diff suppressed the second event: the statement's own guard now
  // refuses the redundant write, so the row is never touched twice.
  assert.equal(state.messageUpdates.length, 1, 'the redundant write never reached the row');

  assert.equal((await react('✅', 'remove')).status, 200);
  assert.deepEqual(state.deliveries.map(d => d.eventType), [REACTION_CREATED, REACTION_REMOVED]);
});

test('the Netlify lane saves the reaction even when the event cannot be queued', async () => {
  resetState({ failDeliveryInsert: true });
  const res = await react('✅', 'add');
  assert.equal(res.status, 200, 'the write succeeds even though the event cannot be queued');
  const body = await res.json();
  assert.equal(body.error, null);
  assert.equal(state.deliveries.length, 0);
  assert.equal(state.messageUpdates.length, 1, 'the reaction row was written');
});

test('the Netlify lane does not deliver a reaction event to another workspace', async () => {
  resetState({
    connections: [
      { id: 'conn-mine', workspace_id: WORKSPACE, channel_id: null, events: [REACTION_CREATED, REACTION_REMOVED] },
      { id: 'conn-theirs', workspace_id: OTHER_WORKSPACE, channel_id: null, events: [REACTION_CREATED, REACTION_REMOVED] },
    ],
  });
  assert.equal((await react('✅', 'add')).status, 200);
  assert.deepEqual(state.deliveries.map(d => d.connectionId), ['conn-mine']);
});

test('a Netlify message edit that does not touch reactions reads no before-image', async () => {
  resetState();
  const res = await handler(new Request('http://localhost/backend/db/update', {
    method: 'POST',
    headers: { Authorization: `Bearer ${issueToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      table: 'messages',
      values: { content: 'edited' },
      filters: [
        { column: 'id', operator: 'eq', value: MESSAGE },
        { column: 'session_id', operator: 'eq', value: SESSION },
      ],
    }),
  }));
  assert.equal(res.status, 200);
  assert.equal(state.deliveries.length, 0);
});
