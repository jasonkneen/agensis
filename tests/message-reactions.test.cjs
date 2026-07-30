'use strict';

// ============================================================================
// tests/message-reactions.test.cjs
// ----------------------------------------------------------------------------
// The atomic reaction toggle: POST /backend/messages/:messageId/reactions.
//
// WHAT WAS WRONG, and what each test here is defending.
//
// `messages.reactions` is a jsonb MAP and the browser used to own the mutation:
// read the map out of React state, splice your id in or out, PUT the WHOLE map
// back through /backend/db/update. Two consequences, both live:
//
//   1. A LOST UPDATE on every concurrent reaction. The read is from a replica of
//      the truth and the write is a full replace, so two people reacting to the
//      same message inside the realtime propagation window each computed a map
//      from a stale base and the second write erased the first.
//   2. FORGEABLE ATTRIBUTION. The map was caller-authored, so any client could
//      write any user's id into it. shared/reaction-events.cjs documents this
//      out loud — `userId` and `actorUserId` are separate fields "because the
//      write path accepts a whole map, so the two CAN differ".
//
// Both come from the mutation living on the client. It now lives in ONE SQL
// statement, and `reactions` is stripped from generic writes so the old door is
// shut rather than merely unused.
//
// WHAT A MOCKED DB CAN AND CANNOT PROVE, stated plainly.
//
// A mock cannot exhibit a lost update — it has no concurrency and no row lock,
// so "two clients raced and both survived" is not a claim this file can make.
// Asserting that the SQL string contains `jsonb_set` would test the string.
//
// So the race is pinned by the property a mock CAN carry honestly, and it is the
// property the fix actually turns on: the mutation is ONE round trip and NOTHING
// reads the reactions map before it. That is exactly what a read-modify-write
// reintroduces, so the read-then-write mutation turns this file red. The
// remaining half — that Postgres re-evaluates the guard after a lock wait — is
// asserted structurally, by requiring the predicate to be in the statement.
//
// The two-browser check is in the design's verification list and is not
// something CI can stand in for.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');
const {
  MAX_DISTINCT_REACTIONS_PER_MESSAGE,
  normalizeReactionValue,
  priorReactionMap,
} = require('../shared/reaction-toggle.cjs');
const { MAX_REACTION_LENGTH, diffReactionMaps } = require('../shared/reaction-events.cjs');
const { PRIVILEGED_DB_COLUMNS_BY_TABLE, stripPrivilegedDbValues } = require('../shared/backend-core.cjs');

const OWNER = 'owner-1';
const VIEWER = 'viewer-1';     // has 'read', NOT 'write'
const OUTSIDER = 'outsider-1'; // not a member of the private session
const ATTACKER = 'attacker-1';
const WORKSPACE = 'w1';
const CHANNEL = 'chan-1';
const DM = 'dm-1';
const MESSAGE = 'msg-1';
const DM_MESSAGE = 'msg-dm-1';

test.afterEach(() => __test.resetTestState());

// Stands in for POSTGRES — it applies the jsonb semantics of the two toggle
// statements. It stands in for NO authorization rule: every membership, role and
// DM check below runs in the real shared code.
//
// `sql` records every statement in order, which is what the round-trip
// assertions read.
function makeDb({ reactions = {}, roles = {}, dmMembers = [] } = {}) {
  const sql = [];
  const state = { reactions: { ...reactions } };
  const db = {
    sql,
    state,
    async unsafe(text, params = []) {
      const n = String(text).replace(/\s+/g, ' ').trim();
      const q = n.toLowerCase();
      sql.push({ sql: n, q, params });

      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'reaction-route-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.includes('union all') && q.includes('workspace_members where workspace_id = $1 and user_id = $2')) {
        const uid = String(params[1]);
        return uid === OWNER || roles[uid] ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select 1 from workspaces where id')) {
        return String(params[1]) === OWNER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) {
        const role = roles[String(params[1])];
        return role ? [{ role }] : [];
      }
      if (q.includes('with recursive chain as')) return [];

      // The route's ONE pre-write read: the message's session plus that
      // session's workspace and privacy, so both gates run against the row the
      // UPDATE then names. Note it does NOT select `reactions`.
      if (q.startsWith('select m.id, m.session_id, s.workspace_id')) {
        if (String(params[0]) === MESSAGE) {
          return [{ id: MESSAGE, session_id: CHANNEL, workspace_id: WORKSPACE, visibility: 'workspace', folder: 'General' }];
        }
        if (String(params[0]) === DM_MESSAGE) {
          return [{ id: DM_MESSAGE, session_id: DM, workspace_id: WORKSPACE, visibility: 'private', folder: 'Direct messages' }];
        }
        return [];
      }
      if (q.startsWith('select 1 from chat_session_members')) {
        return dmMembers.includes(String(params[1])) ? [{ ok: 1 }] : [];
      }

      if (q.startsWith('update messages set reactions = jsonb_set')) {
        const [, , reaction, userId] = params.map(String);
        const holders = state.reactions[reaction] || [];
        if (holders.includes(userId)) return [];
        if (!(reaction in state.reactions)
          && Object.keys(state.reactions).length >= MAX_DISTINCT_REACTIONS_PER_MESSAGE) return [];
        state.reactions = { ...state.reactions, [reaction]: [...holders, userId] };
        return [messageRow(state.reactions)];
      }
      if (q.startsWith('update messages set reactions = case')) {
        const [, , reaction, userId] = params.map(String);
        const holders = state.reactions[reaction] || [];
        if (!holders.includes(userId)) return [];
        const next = { ...state.reactions };
        const remaining = holders.filter(user => user !== userId);
        if (remaining.length === 0) delete next[reaction];
        else next[reaction] = remaining;
        state.reactions = next;
        return [messageRow(state.reactions)];
      }
      // The no-op re-read, and the generic update path's before-image read.
      if (q.startsWith('select id, session_id, reactions, sender_kind')) {
        return [messageRow(state.reactions)];
      }
      if (q.startsWith('select id, workspace_id from chat_sessions where id')) {
        return [{ id: CHANNEL, workspace_id: WORKSPACE }];
      }
      if (q.startsWith('select workspace_id from chat_sessions where id')) {
        return [{ workspace_id: WORKSPACE }];
      }
      if (q.startsWith('update "messages" set')) {
        // The GENERIC path. Reflect whatever it was actually allowed to write,
        // so a `reactions` value that survived the strip would be visible here.
        const setsReactions = q.includes('"reactions" =');
        if (setsReactions) state.reactions = params[0];
        return [messageRow(state.reactions)];
      }
      return [];
    },
  };
  return db;
}

function messageRow(reactions) {
  return {
    id: MESSAGE,
    session_id: CHANNEL,
    reactions,
    sender_kind: 'human',
    sender_id: OWNER,
    sender_name: 'Owner',
    thread_parent_id: null,
    created_at: '2026-07-01T00:00:00.000Z',
  };
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

function react(baseUrl, token, body, messageId = MESSAGE) {
  return fetch(`${baseUrl}/backend/messages/${messageId}/reactions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const isToggle = entry => entry.q.startsWith('update messages set reactions =');

// ---------------------------------------------------------------------------
// The race
// ---------------------------------------------------------------------------

test('the mutation is ONE round trip and nothing reads the map before it', async () => {
  // THE RACE TEST. A read-modify-write is precisely "read the map, then write a
  // map derived from it", so this fails the moment anyone reintroduces one —
  // whether in the route, in a helper, or by re-reading "just to be safe".
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await react(baseUrl, token, { reaction: '✅', op: 'add' })).status, 200);
  });

  const updates = db.sql.filter(isToggle);
  assert.equal(updates.length, 1, 'exactly one mutating statement');

  const before = db.sql.slice(0, db.sql.indexOf(updates[0]));
  const reads = before.filter(entry => entry.q.startsWith('select') && /\breactions\b/.test(entry.q));
  assert.deepEqual(
    reads.map(entry => entry.sql),
    [],
    'NOTHING may read the reactions map before the write — that read is the race',
  );
});

test('the toggle statement carries the guard that makes the lock wait safe', () => {
  // The half a mock cannot exercise: under READ COMMITTED a second concurrent
  // UPDATE blocks on the row lock and then re-evaluates its WHERE against the
  // COMMITTED row. That only saves us if the WHERE actually tests the current
  // map, so the predicate's presence is the property, asserted structurally.
  //
  // Deliberately narrow: it checks the containment test and the row-and-session
  // pin, not the whole statement, so ordinary edits to the SQL do not fail it.
  const { REACTION_ADD_SQL, REACTION_REMOVE_SQL } = require('../shared/reaction-toggle.cjs');
  for (const [name, statement] of [['add', REACTION_ADD_SQL], ['remove', REACTION_REMOVE_SQL]]) {
    assert.match(statement, /where id = \$1::uuid/, `${name} pins the row`);
    assert.match(statement, /and session_id = \$2::uuid/, `${name} pins the session it was authorized against`);
    assert.match(
      statement,
      /coalesce\(reactions -> \$3::text, '\[\]'::jsonb\) @> to_jsonb\(\$4::text\)/,
      `${name} re-tests the STORED map, so a blocked statement re-evaluates against the committed row`,
    );
  }
  assert.match(REACTION_ADD_SQL, /and not coalesce/, 'add fires only when the user is absent');
  assert.doesNotMatch(REACTION_REMOVE_SQL, /and not coalesce/, 'remove fires only when the user is present');
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test('the reactor is req.userId — a body that names someone else is ignored', async () => {
  // The forged-attribution test. The old whole-map path accepted an arbitrary
  // map, so this was writable by anyone; the route binds $4 from the session.
  const db = makeDb({ roles: { [ATTACKER]: 'editor' } });
  __test.setTestDb(db);
  const token = await __test.issueToken(ATTACKER, '1');

  await withServer(async (baseUrl) => {
    const res = await react(baseUrl, token, {
      reaction: '✅', op: 'add', userId: OWNER, user_id: OWNER, actorUserId: OWNER,
    });
    assert.equal(res.status, 200);
  });

  assert.deepEqual(db.state.reactions, { '✅': [ATTACKER] }, 'the caller cannot react as somebody else');
  const [, , , boundUser] = db.sql.filter(isToggle)[0].params;
  assert.equal(String(boundUser), ATTACKER, '$4 is bound from the session, never from the body');
});

// ---------------------------------------------------------------------------
// Idempotency and the empty-key invariant
// ---------------------------------------------------------------------------

test('re-adding the same reaction changes nothing and is not an error', async () => {
  const db = makeDb({ reactions: { '✅': [OWNER] } });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await react(baseUrl, token, { reaction: '✅', op: 'add' });
    assert.equal(res.status, 200, 'a repeat click is success, not a 409');
    const body = await res.json();
    assert.equal(body.data.changed, false);
    assert.deepEqual(body.data.reactions, { '✅': [OWNER] }, 'and reports the state that holds');
  });

  assert.deepEqual(db.state.reactions, { '✅': [OWNER] }, 'no duplicate id in the array');
});

test('removing the last holder DELETES the key rather than leaving an empty array', async () => {
  // normalizeReactionMap treats a reaction nobody holds as ABSENT. A row that
  // kept `[]` would therefore read as a phantom difference on the next diff and
  // emit a removal event for something already removed.
  const db = makeDb({ reactions: { '✅': [OWNER], '🎉': [VIEWER] } });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await react(baseUrl, token, { reaction: '✅', op: 'remove' })).status, 200);
  });

  assert.deepEqual(db.state.reactions, { '🎉': [VIEWER] });
  assert.ok(!('✅' in db.state.reactions), 'the key is gone, not emptied');
  const statement = db.sql.filter(isToggle)[0].sql;
  assert.match(statement, /then coalesce\(reactions, '\{\}'::jsonb\) - \$3::text/, 'the SQL deletes the key');
});

test('removing a reaction you do not hold changes nothing and is not an error', async () => {
  const db = makeDb({ reactions: { '✅': [VIEWER] } });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await react(baseUrl, token, { reaction: '✅', op: 'remove' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).data.changed, false);
  });
  assert.deepEqual(db.state.reactions, { '✅': [VIEWER] }, "another holder's reaction is untouched");
});

// ---------------------------------------------------------------------------
// The distinct-reaction cap
// ---------------------------------------------------------------------------

test('a message cannot grow past the distinct-reaction cap', async () => {
  const full = {};
  for (let i = 0; i < MAX_DISTINCT_REACTIONS_PER_MESSAGE; i += 1) full[`r${i}`] = [VIEWER];
  const db = makeDb({ reactions: full });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await react(baseUrl, token, { reaction: '🆕', op: 'add' });
    assert.equal(res.status, 409, 'refused, and told why — not a silent no-op');
    const body = await res.json();
    assert.match(body.error.message, /at most 24 different reactions/);

    // …but joining one that is ALREADY on the message still works at the cap.
    const joining = await react(baseUrl, token, { reaction: 'r0', op: 'add' });
    assert.equal(joining.status, 200);
    assert.equal((await joining.json()).data.changed, true);
  });

  assert.equal(Object.keys(db.state.reactions).length, MAX_DISTINCT_REACTIONS_PER_MESSAGE);
  const statement = db.sql.filter(isToggle)[0].sql;
  assert.match(statement, /jsonb_object_keys/, 'the cap is in the statement, not read-then-checked');
});

// ---------------------------------------------------------------------------
// The old door
// ---------------------------------------------------------------------------

test('a generic /backend/db/update cannot set reactions', async () => {
  // THE ONE THAT KEEPS THE FIX FROM BEING COSMETIC. Without the
  // PRIVILEGED_DB_COLUMNS_BY_TABLE entry the racy, forgeable path stays open
  // beside the fixed one and every test above proves nothing about the product.
  const db = makeDb({ reactions: { '✅': [OWNER] } });
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');

  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/db/update`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        table: 'messages',
        values: { reactions: { '💀': [OWNER, VIEWER, ATTACKER] }, content: 'edited' },
        filters: [
          { column: 'id', operator: 'eq', value: MESSAGE },
          { column: 'session_id', operator: 'eq', value: CHANNEL },
        ],
      }),
    });
    // Stripped, not refused — the established pattern for this map, so an
    // ordinary edit that echoes the column back still saves.
    assert.equal(res.status, 200);
  });

  assert.deepEqual(db.state.reactions, { '✅': [OWNER] }, 'the forged map never reached the row');
  const generic = db.sql.find(entry => entry.q.startsWith('update "messages" set'));
  assert.ok(generic, 'the edit itself still happened');
  assert.ok(!generic.q.includes('"reactions" ='), 'and it carried no reactions assignment');
});

test('reactions is declared privileged for messages, and the strip actually removes it', () => {
  // Pins the declaration and the behaviour separately: a Set entry with a broken
  // strip, or a working strip on a table nobody declared, are both green if you
  // only assert one of them.
  assert.ok(PRIVILEGED_DB_COLUMNS_BY_TABLE.messages?.has('reactions'));
  const stripped = stripPrivilegedDbValues('messages', { reactions: { x: ['y'] }, content: 'hi' });
  assert.deepEqual(stripped, { content: 'hi' });
});

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------

test('a viewer may read the channel and may not react in it', async () => {
  const db = makeDb({ roles: { [VIEWER]: 'viewer' } });
  __test.setTestDb(db);
  const token = await __test.issueToken(VIEWER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await react(baseUrl, token, { reaction: '✅', op: 'add' })).status, 403);
  });
  assert.deepEqual(db.sql.filter(isToggle), [], 'nothing is written on a refused reaction');
});

test('a workspace member who is not in a DM cannot react inside it', async () => {
  // The session gate under the workspace one. OUTSIDER holds a real role in the
  // workspace — this is the check that stops that being enough.
  const db = makeDb({ roles: { [OUTSIDER]: 'editor' }, dmMembers: [OWNER] });
  __test.setTestDb(db);
  const token = await __test.issueToken(OUTSIDER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await react(baseUrl, token, { reaction: '✅', op: 'add' }, DM_MESSAGE)).status, 403);
  });
  assert.deepEqual(db.sql.filter(isToggle), [], 'nothing is written on a refused reaction');
});

test('a member OF the DM can react inside it', async () => {
  // The negative test above passes trivially against a build that refuses
  // everyone, so the allow direction has to be pinned too.
  const db = makeDb({ roles: { [OUTSIDER]: 'editor' }, dmMembers: [OUTSIDER] });
  __test.setTestDb(db);
  const token = await __test.issueToken(OUTSIDER, '1');

  await withServer(async (baseUrl) => {
    assert.equal((await react(baseUrl, token, { reaction: '✅', op: 'add' }, DM_MESSAGE)).status, 200);
  });
  assert.equal(db.sql.filter(isToggle).length, 1);
});

test('an unauthenticated caller gets 401 and writes nothing', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  await withServer(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/backend/messages/${MESSAGE}/reactions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reaction: '✅', op: 'add' }),
    });
    assert.equal(res.status, 401);
  });
  assert.deepEqual(db.sql.filter(isToggle), []);
});

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

test('an unknown op is refused rather than guessed', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');
  await withServer(async (baseUrl) => {
    for (const op of ['toggle', '', undefined, 'ADD ']) {
      const res = await react(baseUrl, token, { reaction: '✅', op });
      // 'ADD ' normalizes (trim + lowercase); the rest do not.
      assert.equal(res.status, op === 'ADD ' ? 200 : 400, `op=${JSON.stringify(op)}`);
    }
  });
});

test('a reaction that is empty or carries a control character is refused', async () => {
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(OWNER, '1');
  await withServer(async (baseUrl) => {
    for (const reaction of ['', '   ', 'a\nb', ' ', 42, null]) {
      const res = await react(baseUrl, token, { reaction, op: 'add' });
      assert.equal(res.status, 400, `reaction=${JSON.stringify(reaction)}`);
    }
  });
  assert.deepEqual(db.sql.filter(isToggle), []);
});

test('normalizeReactionValue truncates without leaving half an emoji behind', () => {
  const pair = '\u{1F600}';
  const long = 'x'.repeat(MAX_REACTION_LENGTH - 1) + pair.repeat(4);
  const value = normalizeReactionValue(long);
  assert.equal(value.length, MAX_REACTION_LENGTH - 1, 'the split pair was dropped whole');
  assert.ok(!/[\uD800-\uDBFF]$/.test(value), 'no trailing lone surrogate');
  assert.equal(normalizeReactionValue('✅'), '✅', 'an ordinary emoji is untouched');
});

// ---------------------------------------------------------------------------
// The before/after-map contract with shared/reaction-events.cjs
// ---------------------------------------------------------------------------

test('priorReactionMap inverts exactly one transition, so the diff is exactly one change', () => {
  // The contract the flow-webhook feature depends on. The before-image is
  // DERIVED rather than re-read (a SELECT for it would reintroduce the race), so
  // this is the property that makes the derivation trustworthy: feed the diff
  // the derived before-map and the real after-map, and it must see the single
  // change that actually happened — no more, no less.
  const cases = [
    { after: { '✅': ['u1'] }, op: 'add', reaction: '✅', userId: 'u1' },
    { after: { '✅': ['u2', 'u1'] }, op: 'add', reaction: '✅', userId: 'u1' },
    { after: { '✅': ['u2'], '🎉': ['u1'] }, op: 'add', reaction: '🎉', userId: 'u1' },
    { after: {}, op: 'remove', reaction: '✅', userId: 'u1' },
    { after: { '✅': ['u2'] }, op: 'remove', reaction: '✅', userId: 'u1' },
    { after: { '🎉': ['u2'] }, op: 'remove', reaction: '✅', userId: 'u1' },
  ];
  for (const { after, op, reaction, userId } of cases) {
    const before = priorReactionMap(after, { op, reaction, userId });
    const changes = diffReactionMaps(before, after);
    assert.equal(changes.length, 1, `${op} ${reaction}: exactly one change, got ${JSON.stringify(changes)}`);
    assert.equal(changes[0].type, op === 'add' ? 'reaction.created' : 'reaction.removed');
    assert.equal(changes[0].reaction, reaction);
    assert.equal(changes[0].userId, userId);
  }
});

test('priorReactionMap parses a jsonb string, since one lane binds strings', () => {
  const before = priorReactionMap(JSON.stringify({ '✅': ['u1'] }), { op: 'add', reaction: '✅', userId: 'u1' });
  assert.deepEqual(before, {});
});
