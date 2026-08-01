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

test('deleted message anchors stay visible but deleted sessions remain excluded', () => {
 const sql = buildThreadInboxSql();
 const flat = sql.replace(/\s+/g, ' ');
 // Deleting a root or reply must not collapse the thread/sub-thread navigation
 // anchored to its id. Bodies are replaced in SQL, while the canonical session
 // predicate still removes a closed conversation as a whole.
 assert.doesNotMatch(flat, /join messages p on p\.id = x\.parent_id and p\.deleted_at is null/);
 assert.doesNotMatch(flat, /where r\.thread_parent_id is not null and r\.deleted_at is null/);
 assert.doesNotMatch(flat, /where m\.thread_parent_id = x\.parent_id and m\.deleted_at is null/);
 assert.match(sql, /when p\.deleted_at is null then coalesce\(p\.content, ''\)/);
 assert.match(sql, /when m\.deleted_at is null then m\.content/);
 assert.match(sql, /This message was deleted\./);
 assert.match(sql, /rs\.deleted_at is null/, 'the aggregate never scans a closed session');
 assert.match(sql, /s\.deleted_at is null/, 'the canonical read predicate rejects a closed session');
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

// --- F1: the reply aggregate must be workspace-scoped ------------------------
//
// `messages` has no workspace_id column — scoping is only reachable through
// session_id -> chat_sessions.workspace_id. That makes it structurally
// impossible to leak another tenant's rows, and structurally easy to SCAN them:
// a GROUP BY on messages with the workspace qualifier two joins away builds a
// group for every tenant and then throws almost all of them out.

/** The text between `with replies as (` and its matching close paren. */
function repliesCte(sql) {
 const open = sql.indexOf('with replies as (');
 assert.ok(open >= 0, 'the replies CTE moved or was renamed');
 let depth = 0;
 for (let i = sql.indexOf('(', open); i < sql.length; i += 1) {
  if (sql[i] === '(') depth += 1;
  else if (sql[i] === ')') {
   depth -= 1;
   if (depth === 0) return sql.slice(open, i + 1);
  }
 }
 throw new Error('unbalanced parens in the replies CTE');
}

test('the reply aggregate is workspace-scoped INSIDE the CTE, not only outside', () => {
 const sql = buildThreadInboxSql();
 const cte = repliesCte(sql);
 // Measured on production before this landed: a workspace owning ~0% of the
 // platform's thread replies still paid to aggregate all of them. Scoping the
 // CTE took its /threads load from 1.79ms to 0.12ms.
 assert.match(cte, /workspace_id = \$1::uuid/, 'the aggregate scans every tenant without this');
 assert.match(cte, /join chat_sessions rs/);
 // Both the CTE's join and the outer one. The outer is what the older tests
 // pin; the inner is what makes the aggregate cheap. Losing either is a
 // regression, and only counting once would let the CTE's join be deleted.
 assert.ok(
  sql.match(/workspace_id = \$1::uuid/g).length >= 2,
  'the scope must exist in the aggregate AND in the outer query',
 );
});

// --- F2: the server counter must agree with the two client counters ----------

test('reply_count excludes tool steps, and tool steps are counted separately', () => {
 const cte = repliesCte(buildThreadInboxSql());
 // Both client counters exclude tool steps (src/hooks/useChat.ts,
 // src/lib/threadSummary.ts). This one did not, so the same thread showed two
 // different numbers on one screen. Measured on production: a thread the
 // sidebar called "98 replies" has 14 real replies and 84 tool steps.
 assert.match(cte, /count\(\*\) filter \(where coalesce\(r\.message_kind, ''\) <> 'tool_step'\) as reply_count/);
 assert.match(cte, /count\(\*\) filter \(where coalesce\(r\.message_kind, ''\) = 'tool_step'\) as tool_count/);
 assert.doesNotMatch(cte, /count\(\*\) as reply_count/, 'a bare count(*) is the bug this replaced');
});

test('last_reply_at deliberately does NOT exclude tool steps', () => {
 const cte = repliesCte(buildThreadInboxSql());
 // This is a DECISION, not an oversight, and the test exists to make it one.
 // last_reply_at drives ordering and unread; a thread where the agent is
 // actively running tools IS recent. It is intentionally inconsistent with
 // reply_count. Anyone adding a filter here is changing behaviour.
 assert.match(cte, /max\(r\.created_at\) as last_reply_at/);
 assert.doesNotMatch(cte, /max\(r\.created_at\) filter/);
});

test('the last-reply preview skips tool steps', () => {
 const sql = buildThreadInboxSql();
 const lateral = sql.slice(sql.indexOf('left join lateral'), sql.indexOf(') last_msg on true'));
 // Without this the preview line reads "Bash / npm test" instead of whatever
 // the agent actually said.
 assert.match(lateral, /coalesce\(m\.message_kind, ''\) <> 'tool_step'/);
});

test('tool_count reaches the wire shape', () => {
 assert.match(buildThreadInboxSql(), /x\.tool_count\s+as tool_count/);
 const item = toThreadInboxItem({ reply_count: '14', tool_count: '84' });
 assert.equal(item.replyCount, 14);
 assert.equal(item.toolCount, 84, 'the sidebar cannot show tool work without this');
 // A thread whose only replies are tool steps: zero replies, real activity.
 assert.equal(toThreadInboxItem({ reply_count: '0', tool_count: '9' }).toolCount, 9);
 assert.equal(toThreadInboxItem({}).toolCount, 0, 'missing is 0, never NaN');
});
