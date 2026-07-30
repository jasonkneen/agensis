// ============================================================================
// tests/realtime-revocation.test.cjs
// ----------------------------------------------------------------------------
// H4 (2026-07 review): realtime subscriptions were authorized only at subscribe
// time, so a member removed mid-session kept receiving a workspace's live data
// on their open socket. revokeRealtimeAccessForMember re-authorizes an affected
// user's subscriptions against their CURRENT role and drops the ones that no
// longer pass. This exercises it against a fake WS client + mock db.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

// Minimal db answering only the two getWorkspaceRole queries.
//   roles: { `${workspaceId}:${userId}`: role }
function makeDb({ roles = {} } = {}) {
  // The daemon calls getDb().unsafe(sql, params), so the test db is an object
  // with an async `unsafe` method (mirrors tests/backend-auth.test.cjs).
  return {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) return [];
      if (n.startsWith('select role from workspace_members where workspace_id = $1 and user_id = $2')) {
        const role = roles[`${params[0]}:${params[1]}`];
        return role ? [{ role }] : [];
      }
      throw new Error(`Unexpected SQL in test: ${sql}`);
    },
  };
}

function fakeClient(userId, subscriptions) {
  const sent = [];
  return {
    userId,
    readyState: 1,
    subscriptions,
    sent,
    send: (str) => sent.push(JSON.parse(str)),
  };
}

function tasksSub(workspaceId) {
  return {
    channel: `tasks:${workspaceId}`,
    type: 'db_changes',
    table: 'tasks',
    filter: `workspace_id=eq.${workspaceId}`,
  };
}

test.afterEach(() => __test.resetTestState());

test('H4: a removed member loses subscriptions for the revoked workspace only', async () => {
  // u1 was removed from ws-1 (no role) but is still an editor in ws-2.
  __test.setTestDb(makeDb({ roles: { 'ws-2:u1': 'editor' } }));
  const ws = __test.registerTestWebsocketClient(
    fakeClient('u1', [tasksSub('ws-1'), tasksSub('ws-2')]),
  );

  await __test.revokeRealtimeAccessForMember('u1');

  assert.deepEqual(
    ws.subscriptions.map((s) => s.channel),
    ['tasks:ws-2'],
    'ws-1 subscription dropped, ws-2 retained',
  );
  const revoked = ws.sent.find((m) => m.event === 'unsubscribed' && m.channel === 'tasks:ws-1');
  assert.ok(revoked && revoked.reason === 'access_revoked', 'client told ws-1 was revoked');
});

test('H4: other users on the same socket set are untouched', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:u2': 'editor' } }));
  const removed = __test.registerTestWebsocketClient(fakeClient('u1', [tasksSub('ws-1')]));
  const kept = __test.registerTestWebsocketClient(fakeClient('u2', [tasksSub('ws-1')]));

  await __test.revokeRealtimeAccessForMember('u1');

  assert.equal(removed.subscriptions.length, 0, 'removed user u1 loses ws-1');
  assert.equal(kept.subscriptions.length, 1, 'unrelated user u2 keeps ws-1');
});

test('H4: a still-valid member keeps all subscriptions (no false revocation)', async () => {
  __test.setTestDb(makeDb({ roles: { 'ws-1:u1': 'viewer' } }));
  const ws = __test.registerTestWebsocketClient(fakeClient('u1', [tasksSub('ws-1')]));

  await __test.revokeRealtimeAccessForMember('u1');

  assert.equal(ws.subscriptions.length, 1, 'viewer retains read subscription');
  assert.equal(ws.sent.length, 0, 'no revocation message sent');
});
