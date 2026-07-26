// ============================================================================
// tests/thread-inbox.test.cjs
// ----------------------------------------------------------------------------
// The sidebar's Threads list. These pin the SQL's shape rather than its output,
// because the interesting decisions here are all structural: what joins in,
// what is excluded, and what the read comparison truncates to. A query that
// silently loses one of those clauses still returns rows, so nothing else would
// notice.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
 THREAD_INBOX_DEFAULT_LIMIT,
 THREAD_INBOX_MAX_LIMIT,
 clampLimit,
 buildThreadInboxSql,
 toThreadInboxItem,
 threadContextKey,
} = require('../server/thread-inbox.cjs');

test('the limit is clamped, so a caller cannot ask for an unbounded scan', () => {
 assert.equal(clampLimit(10), 10);
 assert.equal(clampLimit(99999), THREAD_INBOX_MAX_LIMIT);
 assert.equal(clampLimit(0), THREAD_INBOX_DEFAULT_LIMIT);
 assert.equal(clampLimit(-5), THREAD_INBOX_DEFAULT_LIMIT);
 assert.equal(clampLimit('nonsense'), THREAD_INBOX_DEFAULT_LIMIT);
 assert.equal(clampLimit(undefined), THREAD_INBOX_DEFAULT_LIMIT);
});

test('the limit reaches the SQL, and only as a clamped integer', () => {
 // Interpolated rather than bound, so an unclamped value would be an injection
 // point as well as a performance one.
 assert.match(buildThreadInboxSql(7), /limit 7$/);
 assert.match(buildThreadInboxSql(99999), new RegExp(`limit ${THREAD_INBOX_MAX_LIMIT}$`));
 assert.doesNotMatch(buildThreadInboxSql("5; drop table messages"), /drop table/i);
});

test('HUDDLE transcripts are excluded', () => {
 // A voice call is not a thread anyone reads back in a sidebar, and its
 // @mention turns would otherwise flood the list — verified against production
 // data, where they did exactly that before this clause existed.
 assert.match(buildThreadInboxSql(), /coalesce\(s\.folder, ''\) <> 'huddle'/);
});

test('deleted messages and deleted sessions are excluded on every join', () => {
 const sql = buildThreadInboxSql();
 // Parent, replies, the last-reply lateral, and the session all need it; a
 // thread whose parent was deleted must not appear with a blank title.
 assert.ok(sql.match(/deleted_at is null/g).length >= 4, 'every join filters deleted rows');
});

test('the follow rule admits human threads and excludes machine-only ones', () => {
 const sql = buildThreadInboxSql();
 // A person started it...
 assert.match(sql, /p\.role = 'user'/);
 // ...or a person replied in it.
 assert.match(sql, /human_replied/);
 // System bookkeeping messages are not a human turn, and neither are agents.
 assert.match(sql, /coalesce\(p\.sender_kind, ''\) <> 'system'/);
 assert.match(sql, /coalesce\(p\.sender_kind, ''\) <> 'agent'/);
});

test('unread is compared at MILLISECOND resolution against the marker', () => {
 // The inbox lost 45 of 45 live markers to a raw comparison: the marker
 // round-trips as an ISO string with millisecond precision, so against a
 // microsecond timestamp a just-read item reads unread by a few hundred
 // microseconds, forever. Same table, same rule, same reason.
 const sql = buildThreadInboxSql();
 assert.match(sql, /date_trunc\('milliseconds', x\.last_reply_at\) > rs\.read_at/);
 assert.match(sql, /rs\.read_at is null/, 'no marker means unread, not read');
});

test('read state is keyed per THREAD, not per session', () => {
 // `thread:<sessionId>` is the inbox's mention key. Sharing it would mean
 // opening one thread marked every thread in the channel read.
 assert.match(buildThreadInboxSql(), /'msgthread:' \|\| p\.id::text/);
 assert.equal(threadContextKey('abc'), 'msgthread:abc');
 assert.equal(threadContextKey(''), '');
 assert.equal(threadContextKey(null), '');
});

test('the workspace is bound, never interpolated', () => {
 const sql = buildThreadInboxSql();
 assert.match(sql, /s\.workspace_id = \$1::uuid/);
 assert.match(sql, /rs\.user_id = \$2::uuid/);
});

test('rows map to the wire shape, with missing values made safe', () => {
 const item = toThreadInboxItem({
  parent_id: 'p1', session_id: 's1', session_title: 'Coder', session_folder: 'General',
  parent_preview: 'are you checking?', parent_sender: 'jason', reply_count: '11',
  last_reply_at: '2026-07-26T10:00:00.000Z', last_reply_preview: 'yes',
  last_reply_sender: 'Sandbox Agent', unread: true,
 });
 assert.equal(item.parentId, 'p1');
 assert.equal(item.replyCount, 11, 'a string count from the driver becomes a number');
 assert.equal(item.unread, true);
 assert.equal(item.lastReplyAt, '2026-07-26T10:00:00.000Z');

 const empty = toThreadInboxItem({});
 assert.equal(empty.sessionId, null, 'a missing session id is null, not the string "null"');
 assert.equal(empty.replyCount, 0);
 assert.equal(empty.unread, false, 'unread is strict: only true means true');
 assert.equal(empty.lastReplyAt, '');
});
