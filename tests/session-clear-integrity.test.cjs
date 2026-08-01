'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');

const { mountSessionsRoutes } = require('../server/sessions-routes.cjs');
const { isPrivateSessionRow, sessionReadableSql } = require('../shared/backend-core.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const TRANSCRIPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const HUDDLE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const BUILTIN_JOB = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const DAEMON_JOB = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const AGENT = '12121212-1212-4121-8121-121212121212';
const CONNECTION = '13131313-1313-4131-8131-131313131313';
const PERMISSION = '14141414-1414-4141-8141-141414141414';

async function requestClear(
  session,
  enforceWorkspaceRole = async () => {},
  enforceSessionRead = async () => {},
) {
  const writes = [];
  const activityScrubs = [];
  const locks = [];
  const notifications = [];
  const builtinCancels = [];
  const connectionFrames = [];
  const drains = [];
  const endedRooms = [];
  const auditEntries = [];
  const app = express();
  app.use(express.json());
  const db = {
    async unsafe(sql, params = []) {
      const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      if (q.startsWith('select id, workspace_id, visibility, folder, deleted_at from chat_sessions')) {
        return [session];
      }
      if (q.includes('select clear_session_scope.id')) {
        locks.push({ sql: q, params });
        return [{ id: SESSION }];
      }
      if (q.startsWith('select huddle.id, huddle.workspace_id')) {
        return String(params[0]).includes(SESSION) ? [{
          id: HUDDLE,
          workspace_id: WORKSPACE,
          session_id: SESSION,
          room_name: 'huddle-room',
          ended_at: null,
          transcript_session_id: TRANSCRIPT,
        }] : [];
      }
      if (q.startsWith('select child_session.id')) {
        locks.push({ sql: q, params });
        return String(params[0]).includes(SESSION) ? [{ id: TRANSCRIPT }] : [];
      }
      if (q.startsWith('update agent_jobs')) {
        writes.push({ sql: q, params });
        return [
          {
            id: BUILTIN_JOB,
            workspace_id: WORKSPACE,
            session_id: SESSION,
            agent_id: AGENT,
            connection_id: null,
            status: 'cancelled',
            metadata: { stopReason: 'cancelled' },
          },
          {
            id: DAEMON_JOB,
            workspace_id: WORKSPACE,
            session_id: TRANSCRIPT,
            agent_id: AGENT,
            connection_id: CONNECTION,
            status: 'cancelled',
            metadata: { stopReason: 'cancelled' },
          },
        ];
      }
      if (q.startsWith('update agent_schedules')) {
        writes.push({ sql: q, params });
        return [{
          id: '15151515-1515-4151-8151-151515151515',
          workspace_id: WORKSPACE,
          session_id: TRANSCRIPT,
          agent_id: AGENT,
          enabled: false,
          running: false,
          last_status: 'Conversation deleted',
        }];
      }
      if (q.startsWith('update agent_permission_requests')) {
        writes.push({ sql: q, params });
        return [{
          id: PERMISSION,
          request_key: 'permission-request-key',
          connection_id: CONNECTION,
          status: 'expired',
        }];
      }
      if (q.startsWith('with cleared_messages')) {
        writes.push({ sql: q, params });
        return [{ cleared_messages: 37 }];
      }
      if (q.startsWith('update chat_sessions')) {
        writes.push({ sql: q, params });
        return [
          { id: SESSION, workspace_id: WORKSPACE, ...session, deleted_at: '2026-07-31T12:00:00.000Z' },
          { id: TRANSCRIPT, workspace_id: WORKSPACE, deleted_at: '2026-07-31T12:00:00.000Z' },
        ];
      }
      if (q.startsWith('update huddles')) {
        writes.push({ sql: q, params });
        return [{
          id: HUDDLE,
          workspace_id: WORKSPACE,
          session_id: SESSION,
          room_name: 'huddle-room',
          ended_at: '2026-07-31T12:00:00.000Z',
          transcript_session_id: TRANSCRIPT,
        }];
      }
      if (q.startsWith('with cleared_presence')) {
        writes.push({ sql: q, params });
        return [{ cleared_presence: 3 }];
      }
      if (q.startsWith('with scrubbed_activity')) {
        activityScrubs.push({ sql: q, params });
        return [{ scrubbed_activity: 37 }];
      }
      throw new Error(`Unexpected clear query: ${sql}`);
    },
    async begin(callback) {
      return callback(this);
    },
  };
  mountSessionsRoutes(app, {
    requireAuth(req, _res, next) {
      req.userId = USER;
      next();
    },
    jsonError(res, status, error) {
      res.status(status).json({ data: null, error: { message: error.message } });
    },
    forbidden(message) {
      const error = new Error(message);
      error.status = 403;
      return error;
    },
    enforceWorkspaceRole,
    enforceSessionRead,
    sessionReadableSql,
    isPrivateSessionRow,
    getDb() { return db; },
    notifyDbSubscribers(table, eventType, rows) {
      notifications.push({ table, eventType, rows });
    },
    cancelBuiltinJob(jobId, reason) {
      builtinCancels.push({ jobId, reason });
    },
    sendToConnection(connectionId, frame) {
      connectionFrames.push({ connectionId, frame });
      return true;
    },
    scheduleTaskQueueDrain(workspaceId, agentId, reason) {
      drains.push({ workspaceId, agentId, reason });
    },
    async endHuddleRoom(roomName) {
      endedRooms.push(roomName);
    },
    async recordAudit(entry) {
      auditEntries.push(entry);
    },
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/backend/sessions/${SESSION}/clear`, {
      method: 'POST',
    });
    const body = await response.clone().json().catch(() => null);
    return {
      response,
      body,
      locks,
      writes,
      activityScrubs,
      notifications,
      builtinCancels,
      connectionFrames,
      drains,
      endedRooms,
      auditEntries,
    };
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('clear refuses public channels before touching transcript rows', async () => {
  const { response, writes } = await requestClear({
    id: SESSION,
    workspace_id: WORKSPACE,
    visibility: 'workspace',
    folder: 'Channels',
    deleted_at: null,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(writes, []);
});

test('clear conceals unknown and unauthorized session classification behind one response', async () => {
  const denied = async () => {
    const error = new Error('Forbidden');
    error.status = 403;
    throw error;
  };
  const candidates = [
    null,
    {
      id: SESSION,
      workspace_id: WORKSPACE,
      visibility: 'workspace',
      folder: 'Channels',
      deleted_at: null,
    },
    {
      id: SESSION,
      workspace_id: WORKSPACE,
      visibility: 'private',
      folder: 'Direct messages',
      deleted_at: null,
    },
  ];

  const responses = [];
  for (const candidate of candidates) {
    const attempt = await requestClear(candidate, denied);
    responses.push({
      status: attempt.response.status,
      body: attempt.body,
      writes: attempt.writes,
    });
  }
  const unreadablePrivate = await requestClear(candidates[2], async () => {}, denied);
  responses.push({
    status: unreadablePrivate.response.status,
    body: unreadablePrivate.body,
    writes: unreadablePrivate.writes,
  });

  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.body, {
      data: null,
      error: { message: 'Conversation not found or unavailable' },
    });
    assert.deepEqual(response.writes, []);
  }
});

test('clear requires manage and keeps a current private-membership predicate in SQL', async () => {
  const checked = [];
  const {
    response,
    body,
    locks,
    writes,
    activityScrubs,
    notifications,
    builtinCancels,
    connectionFrames,
    drains,
    endedRooms,
    auditEntries,
  } = await requestClear({
    id: SESSION,
    workspace_id: WORKSPACE,
    visibility: 'private',
    folder: 'Direct messages',
    deleted_at: null,
  }, async (userId, workspaceId, capability) => {
    checked.push({ userId, workspaceId, capability });
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(body.data.clearedMessages, 37);
  assert.equal(body.data.cancelledJobs, 2);
  assert.deepEqual(checked, [{ userId: USER, workspaceId: WORKSPACE, capability: 'manage' }]);
  assert.equal(locks.length, 3);
  assert.match(locks[0].sql, /chat_session_members/);
  assert.match(locks[0].sql, /visibility is not distinct from \$3/);
  assert.match(locks[0].sql, /folder is not distinct from \$4/);
  assert.match(locks[0].sql, /with recursive clear_workspace_chain/);
  assert.match(locks[0].sql, /clear_manager_membership/);
  assert.match(locks[0].sql, /for share of workspace/);
  assert.match(locks[0].sql, /for share of membership/);
  assert.match(locks[0].sql, /for update of clear_session_scope, clear_session_member/);
  assert.deepEqual(locks[0].params, [SESSION, USER, 'private', 'Direct messages', WORKSPACE]);
  assert.match(locks[1].sql, /^select child_session\.id/);
  assert.match(locks[1].sql, /for update/);
  assert.deepEqual(locks[1].params, [`{"${SESSION}"}`, `{"${SESSION}"}`]);
  assert.match(locks[2].sql, /^select child_session\.id/);
  assert.deepEqual(
    locks[2].params,
    [`{"${TRANSCRIPT}"}`, `{"${SESSION}","${TRANSCRIPT}"}`],
  );
  assert.equal(writes.length, 7);
  assert.match(writes[0].sql, /^update agent_schedules/);
  assert.match(writes[0].sql, /enabled = false/);
  assert.match(writes[1].sql, /^update agent_jobs/);
  assert.match(writes[1].sql, /status = 'cancelled'/);
  assert.match(writes[1].sql, /"stopreason":"cancelled"/);
  assert.match(writes[2].sql, /^update agent_permission_requests/);
  assert.match(writes[2].sql, /status = 'expired'/);
  assert.match(writes[3].sql, /^with cleared_messages/);
  assert.match(writes[3].sql, /update messages/);
  assert.match(writes[4].sql, /^update chat_sessions/);
  assert.match(writes[5].sql, /^update huddles/);
  assert.match(writes[6].sql, /^with cleared_presence/);
  for (const write of writes) {
    assert.doesNotMatch(write.sql, /returning \*/i);
  }
  assert.equal(activityScrubs.length, 1);
  assert.match(activityScrubs[0].sql, /activity_message\.session_id = any\(\$1::uuid\[\]\)/);
  assert.match(activityScrubs[0].sql, /metadata = jsonb_build_object/);
  assert.deepEqual(activityScrubs[0].params[0], `{"${SESSION}","${TRANSCRIPT}"}`);
  assert.equal(activityScrubs[0].params[1], 'Message deleted');
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
  assert.deepEqual(connectionFrames, [
    {
      connectionId: CONNECTION,
      frame: { type: 'agent_job_cancel', jobId: DAEMON_JOB, reason: 'Conversation deleted' },
    },
    {
      connectionId: CONNECTION,
      frame: {
        type: 'agent_permission_abort',
        requestId: 'permission-request-key',
        message: 'Conversation deleted.',
      },
    },
  ]);
  assert.deepEqual(drains, [
    { workspaceId: WORKSPACE, agentId: AGENT, reason: 'conversation_deleted' },
  ]);
  assert.deepEqual(endedRooms, ['huddle-room']);
  assert.equal(auditEntries.length, 1);
  assert.equal(auditEntries[0].action, 'chat_session.cleared');
});

test('Netlify clear route mirrors the manage and private-session gates', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../netlify/functions/backend.mjs'), 'utf8');
  const body = source.match(/async function handleClearSession[\s\S]*?\n}\n\nasync function handleDb/)?.[0] || '';
  assert.match(body, /authorizeSessionForUser\([\s\S]*sessionId,[\s\S]*userId,[\s\S]*'manage',[\s\S]*concealUnavailable: true/);
  assert.match(body, /isPrivateSessionRow\(gate\.session\)/);
  assert.match(body, /withDbTransaction\(async \(transactionQuery\)/);
  assert.match(body, /sessionReadableSql\('clear_session_scope', '\$2'\)/);
  assert.match(body, /join chat_session_members clear_session_member/);
  assert.match(body, /for update of clear_session_scope, clear_session_member/);
  assert.match(body, /visibility is not distinct from \$3/);
  assert.match(body, /folder is not distinct from \$4/);
  assert.match(body, /gate\.session\.visibility \?\? null/);
  assert.match(body, /gate\.session\.folder \?\? null/);
  assert.match(body, /settleSessionClosure\(\{/);
  assert.match(body, /hostSessionIds: \[sessionId\]/);
  assert.match(body, /closeHostSessions: true/);
  assert.match(body, /cancelledJobs/);
});
