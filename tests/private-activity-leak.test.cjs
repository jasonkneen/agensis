// ============================================================================
// tests/private-activity-leak.test.cjs
// ----------------------------------------------------------------------------
// A members-only conversation must not put its message bodies into the
// workspace-wide activity feed.
//
// `activity_events` is the widest table in the product: it is in ALLOWED_TABLES,
// it is workspace-scoped, its select capability is `read` (so a VIEWER
// qualifies), it is absent from SELECTABLE_COLUMNS_BY_TABLE (so `columns:"*"`
// returns `metadata` whole), `appendSessionAccessClause` returns untouched for
// any table that is not chat_sessions/messages, and the realtime private lane
// in server/realtime.cjs only splits chat_sessions rows.
//
// So there is NO downstream control. Whatever is written here is readable by
// every member of the workspace, and was: one /backend/db/select on
// activity_events returned the full text of every private DM.
//
// The fix is at write time, and it has to cut BOTH carriers — `metadata.content`
// held the whole body, and `title` held its first 80 characters, which is still
// the message. These tests pin both, on both write paths, and the public-session
// case is the control: if someone "fixes" this by redacting unconditionally, the
// feed silently dies for ordinary channels and that test fails.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs');

let core;
test.before(async () => {
  core = await import(pathToFileURL(path.resolve(__dirname, '../shared/backend-core.cjs')).href);
});

const SECRET = 'the merger closes friday, do not tell anyone';

// Records what actually reached the INSERT. The mock never decides privacy —
// it returns the session columns verbatim and lets isPrivateSessionRow (in the
// code under test) rule. Delete the redaction branch and these fail.
function makeDb(sessionRow) {
  const inserts = [];
  async function db(sql, params = []) {
    const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
    if (n.startsWith('select workspace_id') && n.includes('from chat_sessions where id = $1')) {
      return sessionRow ? [sessionRow] : [];
    }
    if (n.startsWith('insert into activity_events')) {
      inserts.push({ title: params[3], metadata: JSON.parse(params[4]) });
      return [];
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  }
  return { db, inserts };
}

const message = {
  id: 'msg-1',
  session_id: 'sess-1',
  role: 'user',
  sender_name: 'Jane',
  sender_kind: 'user',
  content: SECRET,
};

test('a private session writes NEITHER the body nor a body-derived title', async () => {
  const { db, inserts } = makeDb({ workspace_id: 'ws-1', visibility: 'private', folder: null });
  await core.logMessageActivityIdempotent([message], { db });

  assert.equal(inserts.length, 1, 'the feed still records that a message happened');
  const [row] = inserts;

  assert.equal(row.metadata.content, undefined, 'metadata.content must be absent, not empty-string');
  assert.ok(!('content' in row.metadata), 'the key itself must not be present');
  assert.ok(!row.title.includes('merger'), `title leaked the body: ${row.title}`);
  assert.ok(!JSON.stringify(row).includes('merger'), 'no part of the row may contain the body');

  // Still useful: who, and which session, so the feed can link.
  assert.equal(row.metadata.session_id, 'sess-1');
  assert.equal(row.metadata.sender_name, 'Jane');
  assert.ok(row.title.startsWith('Jane:'));
});

test('the folder backstop alone makes a session private', async () => {
  // A DM-creating path that forgets to set `visibility` must not produce a
  // world-readable DM. isPrivateSessionRow ORs the two signals; this pins that
  // the activity path gets the benefit of the backstop too.
  const { db, inserts } = makeDb({ workspace_id: 'ws-1', visibility: null, folder: 'Direct messages' });
  await core.logMessageActivityIdempotent([message], { db });

  assert.equal(inserts.length, 1);
  assert.ok(!JSON.stringify(inserts[0]).includes('merger'), 'folder-only DM leaked its body');
});

test('CONTROL: an ordinary channel still records the message, or the feed is dead', async () => {
  // Without this, redacting unconditionally would pass every other test here
  // while quietly emptying the activity feed for every non-DM conversation.
  const { db, inserts } = makeDb({ workspace_id: 'ws-1', visibility: 'workspace', folder: 'Channels' });
  await core.logMessageActivityIdempotent([message], { db });

  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].metadata.content, SECRET, 'a public channel message must still carry its content');
  assert.ok(inserts[0].title.includes('merger'), 'a public channel title still previews the message');
});

test('a session that cannot be resolved writes nothing at all', async () => {
  const { db, inserts } = makeDb(null);
  await core.logMessageActivityIdempotent([message], { db });
  assert.equal(inserts.length, 0);
});

// ---------------------------------------------------------------------------
// The backfill. Rows written before the fix still hold the bodies, so the code
// change alone leaves the exposure in place.
// ---------------------------------------------------------------------------

test('the scrub statement targets private sessions and clears both carriers', () => {
  const { SCRUB_PRIVATE_ACTIVITY_SQL } = require('../server/dm-scope-backfill.cjs');
  const sql = SCRUB_PRIVATE_ACTIVITY_SQL.replace(/\s+/g, ' ').toLowerCase();

  assert.ok(sql.includes("metadata - 'content'"), 'must drop the content key');
  assert.ok(sql.includes('(private conversation)'), 'must overwrite the body-derived title');
  assert.ok(
    sql.includes("coalesce(cs.visibility, '') = 'private'") && sql.includes("coalesce(cs.folder, '') = 'direct messages'"),
    'must match BOTH privacy signals, the same pair isPrivateSessionRow ORs',
  );
  // Idempotence: it only touches rows that still have a body, so a second boot
  // is a no-op rather than re-titling every row again.
  assert.ok(sql.includes("(ae.metadata->>'content') is not null"), 'must be idempotent on re-run');
});

test('the scrub runs AFTER the visibility passes that mark DMs private', () => {
  // Order is load-bearing: the scrub matches on visibility/folder, so a session
  // only just marked private by MARK_DMS_SQL/MARK_DERIVED_SQL would be skipped
  // if the scrub ran first. This pins the ordering in the source.
  const src = fs.readFileSync(path.resolve(__dirname, '../server/dm-scope-backfill.cjs'), 'utf8');
  const body = src.slice(src.indexOf('async function runDmScopeBackfill'));
  assert.ok(
    body.indexOf('MARK_DERIVED_SQL') < body.indexOf('SCRUB_PRIVATE_ACTIVITY_SQL'),
    'the scrub must be invoked after the visibility backfills',
  );
});
