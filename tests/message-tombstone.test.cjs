'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { mountSessionsRoutes } = require('../server/sessions-routes.cjs');
const {
  DELETED_MESSAGE_CONTENT,
  redactDeletedMessageRow,
  redactDeletedMessageRows,
} = require('../shared/backend-core.cjs');

const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PARENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function deletedRow() {
  return {
    id: MESSAGE,
    session_id: SESSION,
    role: 'user',
    content: 'secret deleted words',
    attachments: [{ id: 'file-1', name: 'secret.txt' }],
    message_kind: 'tool_step',
    tool_name: 'Read',
    tool_detail: '/secret/path',
    reactions: { fire: [USER] },
    pinned: true,
    source_task_id: '12121212-1212-4121-8121-121212121212',
    huddle_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    permission_request_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    thread_parent_id: PARENT,
    sender_kind: 'user',
    sender_id: USER,
    sender_name: 'Alice',
    deleted_at: '2026-07-31T12:00:00.000Z',
    created_at: '2026-07-31T11:00:00.000Z',
  };
}

test('a deleted message becomes a payload-free tombstone while retaining its structural anchor', () => {
  const tombstone = redactDeletedMessageRow(deletedRow());
  assert.equal(tombstone.content, DELETED_MESSAGE_CONTENT);
  assert.deepEqual(tombstone.attachments, []);
  assert.equal(tombstone.message_kind, '');
  assert.equal(tombstone.tool_name, '');
  assert.equal(tombstone.tool_detail, '');
  assert.deepEqual(tombstone.reactions, {});
  assert.equal(tombstone.pinned, false);
  assert.equal(tombstone.source_task_id, null);
  assert.equal(tombstone.huddle_id, null);
  assert.equal(tombstone.permission_request_id, null);
  assert.equal(tombstone.id, MESSAGE);
  assert.equal(tombstone.thread_parent_id, PARENT);
  assert.equal(tombstone.sender_id, USER);
  assert.equal(tombstone.deleted_at, '2026-07-31T12:00:00.000Z');
});

test('the paginated Fly transcript returns a redacted deleted root instead of dropping its replies anchor', async () => {
  const app = express();
  mountSessionsRoutes(app, {
    requireAuth(req, _res, next) { req.userId = USER; next(); },
    jsonError(res, status, error) {
      res.status(status).json({ data: null, error: { message: error.message } });
    },
    async enforceWorkspaceRole() {},
    async enforceSessionRead() {},
    async resolveWorkspaceIdForSession() { return WORKSPACE; },
    redactDeletedMessageRows,
    cancelBuiltinJob() {},
    sendToConnection() { return true; },
    scheduleTaskQueueDrain() {},
    async endHuddleRoom() {},
    getDb() {
      return {
        async unsafe(sql) {
          const q = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
          if (q.startsWith('select * from messages')) return [deletedRow()];
          throw new Error(`Unexpected transcript query: ${sql}`);
        },
      };
    },
  });
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(
      `http://127.0.0.1:${server.address().port}/backend/sessions/${SESSION}/messages?limit=200`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const payload = await response.json();
    assert.equal(payload.data.messages.length, 1);
    assert.equal(payload.data.messages[0].content, DELETED_MESSAGE_CONTENT);
    assert.deepEqual(payload.data.messages[0].attachments, []);
    assert.equal(payload.data.messages[0].id, MESSAGE);
    assert.equal(payload.data.messages[0].thread_parent_id, PARENT);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
