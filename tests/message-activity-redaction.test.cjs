'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/backend-core.cjs');

const MESSAGE = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

test('single-message activity scrub replaces both body carriers with a minimal envelope', async () => {
  const calls = [];
  const rows = await core.scrubMessageActivityByMessageId({
    messageId: MESSAGE,
    sessionId: SESSION,
    async db(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return [{
        title: 'Message deleted',
        metadata: { session_id: SESSION, deleted: true },
      }];
    },
  });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /entity_id = \$1::text/i);
  assert.match(calls[0].sql, /title = \$3/i);
  assert.match(calls[0].sql, /metadata = jsonb_build_object/i);
  assert.deepEqual(calls[0].params, [MESSAGE, SESSION, 'Message deleted']);
  assert.doesNotMatch(JSON.stringify(rows[0]), /secret|content/i);
});

test('session activity scrub is set-based and returns only a count', async () => {
  const calls = [];
  await core.scrubMessageActivityBySession({
    sessionId: SESSION,
    async db(sql, params) {
      calls.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
      return [{ scrubbed_activity: 12 }];
    },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /from messages activity_message/i);
  assert.match(calls[0].sql, /activity_message\.session_id = \$1::uuid/i);
  assert.match(calls[0].sql, /select count\(\*\)::integer as scrubbed_activity/i);
  assert.doesNotMatch(calls[0].sql, /returning activity_event\.\*/i);
  assert.deepEqual(calls[0].params, [SESSION, 'Message deleted']);
});

test('activity logging locks and proves the message is still live before mirroring it', async () => {
  const calls = [];
  await core.logMessageActivityIdempotent([{
    id: MESSAGE,
    session_id: SESSION,
    role: 'user',
    content: 'public body',
  }], {
    async db(sql, params) {
      const normalized = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ sql: normalized, params });
      if (/^select workspace_id/i.test(normalized)) {
        return [{ workspace_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', visibility: 'workspace', folder: 'Channels' }];
      }
      return [];
    },
  });
  const insert = calls.find(call => /insert into activity_events/i.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /from messages/i);
  assert.match(insert.sql, /deleted_at is null/i);
  assert.match(insert.sql, /for share/i);
});
