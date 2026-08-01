'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_DERIVATION_DEPTH,
  settleSessionClosure,
} = require('../shared/session-close.cjs');
const {
  applySessionClosureRuntimeEffects,
} = require('../server/session-close-runtime.cjs');

const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HOST = '10000000-0000-4000-8000-000000000001';
const SUBTHREAD = '10000000-0000-4000-8000-000000000002';
const FORK = '10000000-0000-4000-8000-000000000003';
const ACTIVE_TRANSCRIPT = '10000000-0000-4000-8000-000000000004';
const ENDED_TRANSCRIPT = '10000000-0000-4000-8000-000000000005';
const GRANDCHILD = '10000000-0000-4000-8000-000000000006';
const ACTIVE_HUDDLE = '20000000-0000-4000-8000-000000000001';
const ENDED_HUDDLE = '20000000-0000-4000-8000-000000000002';
const AGENT = '30000000-0000-4000-8000-000000000001';
const BUILTIN_JOB = '40000000-0000-4000-8000-000000000001';
const DAEMON_JOB = '40000000-0000-4000-8000-000000000002';
const CONNECTION = '50000000-0000-4000-8000-000000000001';
const PERMISSION = '60000000-0000-4000-8000-000000000001';
const SCHEDULE = '70000000-0000-4000-8000-000000000001';

function parsePgArray(value) {
  const text = String(value || '');
  if (text === '{}') return [];
  return [...text.matchAll(/"([^"]+)"/g)].map(match => match[1]);
}

function sessionRow(id) {
  return {
    id,
    workspace_id: WORKSPACE,
    title: id === HOST ? 'Host' : 'Derived',
    deleted_at: '2026-07-31T12:00:00.000Z',
    updated_at: '2026-07-31T12:00:00.000Z',
  };
}

function huddleRow(id, transcriptSessionId, endedAt = null) {
  return {
    id,
    workspace_id: WORKSPACE,
    session_id: HOST,
    room_name: `room-${id}`,
    ended_at: endedAt,
    transcript_session_id: transcriptSessionId,
  };
}

function makeClosureDb() {
  const statements = [];
  const allSessions = [HOST, SUBTHREAD, FORK, ACTIVE_TRANSCRIPT, ENDED_TRANSCRIPT, GRANDCHILD];
  const query = async (sql, params = []) => {
    const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    statements.push({ sql: q, params });
    if (q.startsWith('select huddle.id, huddle.workspace_id')) {
      const frontier = parsePgArray(params[0]);
      if (frontier.includes(HOST)) {
        return [
          huddleRow(ACTIVE_HUDDLE, ACTIVE_TRANSCRIPT),
          huddleRow(ENDED_HUDDLE, ENDED_TRANSCRIPT, '2026-07-30T12:00:00.000Z'),
        ];
      }
      return [];
    }
    if (q.startsWith('select child_session.id')) {
      const frontier = parsePgArray(params[0]);
      if (frontier.includes(HOST)) {
        return [
          { id: SUBTHREAD },
          { id: FORK },
          { id: ACTIVE_TRANSCRIPT },
          { id: ENDED_TRANSCRIPT },
        ];
      }
      if (frontier.includes(SUBTHREAD)) return [{ id: GRANDCHILD }];
      return [];
    }
    if (q.startsWith('update agent_jobs')) {
      return [
        {
          id: BUILTIN_JOB,
          workspace_id: WORKSPACE,
          session_id: HOST,
          agent_id: AGENT,
          connection_id: null,
          status: 'cancelled',
          metadata: { stopReason: 'cancelled' },
        },
        {
          id: DAEMON_JOB,
          workspace_id: WORKSPACE,
          session_id: GRANDCHILD,
          agent_id: AGENT,
          connection_id: CONNECTION,
          status: 'cancelled',
          metadata: { stopReason: 'cancelled' },
        },
      ];
    }
    if (q.startsWith('update agent_schedules')) {
      return [{
        id: SCHEDULE,
        workspace_id: WORKSPACE,
        session_id: GRANDCHILD,
        agent_id: AGENT,
        enabled: false,
        running: false,
        last_status: 'Conversation deleted',
      }];
    }
    if (q.startsWith('update agent_permission_requests')) {
      return [{
        id: PERMISSION,
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        job_id: DAEMON_JOB,
        session_id: GRANDCHILD,
        connection_id: CONNECTION,
        request_key: 'permission-key',
        status: 'expired',
      }];
    }
    if (q.startsWith('with cleared_messages')) return [{ cleared_messages: 99 }];
    if (q.startsWith('update chat_sessions')) {
      return parsePgArray(params[0]).map(sessionRow);
    }
    if (q.startsWith('update huddles')) {
      return [huddleRow(
        ACTIVE_HUDDLE,
        ACTIVE_TRANSCRIPT,
        '2026-07-31T12:00:00.000Z',
      )];
    }
    if (q.startsWith('with cleared_presence')) return [{ cleared_presence: 2 }];
    if (q.startsWith('with scrubbed_activity')) return [{ scrubbed_activity: 99 }];
    throw new Error(`Unexpected closure query: ${sql}`);
  };
  return { allSessions, query, statements };
}

test('conversation closure recursively settles subthreads, forks, and every huddle transcript', async () => {
  const { allSessions, query, statements } = makeClosureDb();
  const effects = await settleSessionClosure({
    query,
    hostSessionIds: [HOST],
    closeHostSessions: true,
  });

  assert.deepEqual(new Set(effects.allSessionIds), new Set(allSessions));
  assert.deepEqual(new Set(effects.sessions.map(row => row.id)), new Set(allSessions));
  assert.equal(effects.clearedMessages, 99);
  assert.equal(effects.clearedPresence, 2);
  assert.deepEqual(effects.jobs.map(row => row.id), [BUILTIN_JOB, DAEMON_JOB]);
  assert.deepEqual(effects.schedules.map(row => row.id), [SCHEDULE]);
  assert.deepEqual(effects.permissionRequests.map(row => row.id), [PERMISSION]);
  assert.deepEqual(
    effects.huddles.map(row => row.id),
    [ACTIVE_HUDDLE],
    'only the active->ended compare-and-set winner gets a runtime room delete',
  );

  const derivedLocks = statements.filter(statement => statement.sql.startsWith('select child_session.id'));
  assert.equal(derivedLocks.length, 3);
  assert.match(derivedLocks[0].sql, /child_session\.split_parent_id = parent_session\.id/);
  assert.match(derivedLocks[0].sql, /parent_message\.session_id = parent_session\.id/);
  assert.match(derivedLocks[0].sql, /parent_huddle\.transcript_session_id = child_session\.id/);
  assert.match(derivedLocks[0].sql, /parent_session\.workspace_id = child_session\.workspace_id/);
  assert.match(derivedLocks[0].sql, /for update of child_session/);

  const huddleLocks = statements.filter(statement => statement.sql.startsWith('select huddle.id'));
  assert.equal(huddleLocks.length, 3);
  assert.ok(
    statements.indexOf(huddleLocks[0]) < statements.indexOf(derivedLocks[0]),
    'each session frontier locks its huddles before derived transcript sessions',
  );

  const activity = statements.find(statement => statement.sql.startsWith('with scrubbed_activity'));
  assert.deepEqual(new Set(parsePgArray(activity.params[0])), new Set(allSessions));
});

test('a generic host update still closes every descendant inside the helper transaction', async () => {
  const { allSessions, query } = makeClosureDb();
  const effects = await settleSessionClosure({
    query,
    hostSessionIds: [HOST],
    closeHostSessions: false,
  });
  assert.deepEqual(
    new Set(effects.sessions.map(row => row.id)),
    new Set(allSessions.filter(id => id !== HOST)),
  );
});

test('closure runtime effects use exact compare-and-set rows and fail visibly but safely', async () => {
  const notifications = [];
  const builtinCancels = [];
  const frames = [];
  const drains = [];
  const endedRooms = [];
  const warnings = [];

  await applySessionClosureRuntimeEffects({
    sessions: [sessionRow(HOST), sessionRow(SUBTHREAD)],
    jobs: [
      {
        id: BUILTIN_JOB,
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        connection_id: null,
      },
      {
        id: DAEMON_JOB,
        workspace_id: WORKSPACE,
        agent_id: AGENT,
        connection_id: CONNECTION,
      },
    ],
    schedules: [{
      id: SCHEDULE,
      workspace_id: WORKSPACE,
      session_id: GRANDCHILD,
      agent_id: AGENT,
      enabled: false,
      running: false,
      last_status: 'Conversation deleted',
    }],
    permissionRequests: [{
      id: PERMISSION,
      request_key: 'permission-key',
      connection_id: CONNECTION,
    }],
    huddles: [huddleRow(
      ACTIVE_HUDDLE,
      ACTIVE_TRANSCRIPT,
      '2026-07-31T12:00:00.000Z',
    )],
  }, {
    notifyDbSubscribers(table, eventType, rows) {
      notifications.push({ table, eventType, rows });
    },
    cancelBuiltinJob(jobId, reason) {
      builtinCancels.push({ jobId, reason });
    },
    sendToConnection(connectionId, frame) {
      frames.push({ connectionId, frame });
      return false;
    },
    scheduleTaskQueueDrain(workspaceId, agentId, reason) {
      drains.push({ workspaceId, agentId, reason });
    },
    async endHuddleRoom(roomName) {
      endedRooms.push(roomName);
    },
    onWarn(message) {
      warnings.push(message);
    },
  });

  assert.deepEqual(
    notifications.map(({ table, eventType }) => ({ table, eventType })),
    [
      { table: 'chat_sessions', eventType: 'UPDATE' },
      { table: 'agent_jobs', eventType: 'UPDATE' },
      { table: 'agent_schedules', eventType: 'UPDATE' },
      { table: 'agent_permission_requests', eventType: 'UPDATE' },
      { table: 'huddles', eventType: 'UPDATE' },
    ],
  );
  assert.deepEqual(builtinCancels, [
    { jobId: BUILTIN_JOB, reason: 'Conversation deleted' },
    { jobId: DAEMON_JOB, reason: 'Conversation deleted' },
  ]);
  assert.equal(frames.length, 2);
  assert.deepEqual(drains, [
    { workspaceId: WORKSPACE, agentId: AGENT, reason: 'conversation_deleted' },
  ]);
  assert.deepEqual(endedRooms, [`room-${ACTIVE_HUDDLE}`]);
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /daemon cancellation was not delivered/);
  assert.match(warnings[1], /permission denial was not delivered/);
});

test('the derivation traversal has an explicit fail-closed depth bound', () => {
  assert.equal(MAX_DERIVATION_DEPTH, 64);
});
