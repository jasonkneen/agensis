// ============================================================================
// tests/activity-idempotency.test.cjs
// ----------------------------------------------------------------------------
// Recommended Minimum Test Plan — ITEM 5: Activity idempotency.
//
// `logMessageActivityIdempotent` writes one `activity_events` row per inserted
// chat message. Idempotency is guaranteed at the DB level by a partial unique
// index + `ON CONFLICT DO NOTHING`, so the SAME message id logged twice can
// never duplicate the feed row.
//
// The mock `db` here records inserts and simulates that partial unique index:
// a second insert for an already-seen message id is a no-op (stores nothing),
// exactly as Postgres would with ON CONFLICT DO NOTHING.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let core;
test.before(async () => {
  core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.cjs')).href);
});

// Mock db simulating the activity_events insert path.
//   sessions: { [sessionId]: workspaceId }
//             | { [sessionId]: { workspaceId, visibility, folder } }
// The object form exists so a test can make a session members-only. The mock
// hands back whatever `visibility`/`folder` it is given and does NOT decide
// privacy itself — `isPrivateSessionRow` in the code under test owns that rule,
// so deleting the redaction branch makes the assertions fail rather than the
// mock quietly agreeing with itself.
function makeActivityDb({ sessions = {} } = {}) {
  const stored = [];          // rows that survived the conflict check
  const insertAttempts = [];  // every insert call (params)
  const seenMessageIds = new Set();

  async function db(sql, params = []) {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();

    if (n.startsWith('select workspace_id') && n.includes('from chat_sessions where id = $1')) {
      const entry = sessions[params[0]];
      if (!entry) return [];
      if (typeof entry === 'string') return [{ workspace_id: entry }];
      return [{
        workspace_id: entry.workspaceId,
        visibility: entry.visibility ?? null,
        folder: entry.folder ?? null,
      }];
    }

    if (n.includes('insert into activity_events')) {
      insertAttempts.push(params);
      const messageId = params[2]; // (workspace_id, user_id, event_type? ...) -> entity_id is $3
      // Partial unique index: dedupe on entity_id for message_sent/message rows.
      if (messageId != null && seenMessageIds.has(messageId)) {
        return []; // ON CONFLICT DO NOTHING -> no row inserted
      }
      if (messageId != null) seenMessageIds.add(messageId);
      stored.push({ workspace_id: params[0], user_id: params[1], entity_id: messageId });
      return [];
    }

    throw new Error(`Unexpected SQL in test: ${sql}`);
  }

  return { db, stored, insertAttempts };
}

test('logging the SAME message id twice yields exactly ONE activity row', async () => {
  const { db, stored, insertAttempts } = makeActivityDb({ sessions: { 'sess-1': 'ws-1' } });
  const message = {
    id: 'msg-1', session_id: 'sess-1', role: 'agent',
    sender_name: 'Agent', content: 'Hello from the agent',
  };

  await core.logMessageActivityIdempotent([message], { db });
  await core.logMessageActivityIdempotent([message], { db }); // retry / duplicate finalize

  assert.equal(insertAttempts.length, 2, 'both calls should attempt the insert');
  assert.equal(stored.length, 1, 'only one row survives the ON CONFLICT DO NOTHING');
  assert.equal(stored[0].entity_id, 'msg-1');
});

test('distinct message ids each produce their own activity row', async () => {
  const { db, stored } = makeActivityDb({ sessions: { 'sess-1': 'ws-1' } });

  await core.logMessageActivityIdempotent([
    { id: 'msg-a', session_id: 'sess-1', role: 'user', content: 'one' },
    { id: 'msg-b', session_id: 'sess-1', role: 'agent', content: 'two' },
  ], { db });

  assert.equal(stored.length, 2);
  assert.deepEqual(stored.map(r => r.entity_id).sort(), ['msg-a', 'msg-b']);
});

test('a message whose session has no workspace is skipped (no insert)', async () => {
  const { db, stored, insertAttempts } = makeActivityDb({ sessions: {} }); // unknown session
  await core.logMessageActivityIdempotent(
    [{ id: 'msg-x', session_id: 'sess-missing', role: 'user', content: 'orphan' }],
    { db },
  );
  assert.equal(insertAttempts.length, 0);
  assert.equal(stored.length, 0);
});

test('a db failure during logging never throws to the caller (defensive)', async () => {
  const db = async (sql) => {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (n.startsWith('select workspace_id from chat_sessions')) return [{ workspace_id: 'ws-1' }];
    throw new Error('simulated insert failure');
  };
  await assert.doesNotReject(
    () => core.logMessageActivityIdempotent(
      [{ id: 'msg-1', session_id: 'sess-1', role: 'user', content: 'boom' }],
      { db },
    ),
  );
});
