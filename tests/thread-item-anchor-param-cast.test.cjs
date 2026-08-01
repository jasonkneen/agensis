// ============================================================================
// tests/thread-item-anchor-param-cast.test.cjs
// ----------------------------------------------------------------------------
// create_thread_item was 100% BROKEN on every call — including the minimal
// three-required-arg call with no message_id at all:
//
//     Internal error executing create_thread_item:
//     inconsistent types deduced for parameter $6
//
// The cause is Postgres PARAMETER TYPE DEDUCTION, which happens at PARSE time
// from the statement text alone. The value of $6 is irrelevant, which is why
// passing null did not dodge it. In the insert, $6 appeared in two roles:
//
//     insert into thread_items (..., message_id, ...)
//       select ..., $6, $7            -- target column is `message_id uuid`
//                                     --   => $6 deduced as uuid
//      where ...
//        and ( $6::text is null       -- explicit ::text
//              or exists (... thread_item_anchor.id::text = $6::text ...))
//                                     --   => $6 deduced as text
//
// uuid and text are not the same type, Postgres refuses to guess, and the whole
// statement fails to parse. Nothing ever reached the database.
//
// THE FIX pins $6 to text everywhere and converts at the insert site:
//
//     nullif($6::text, '')::uuid
//
// text-uniform rather than uuid-uniform on purpose. Making every site $6::uuid
// would also parse, but it CHANGES BEHAVIOUR for a malformed message_id: the
// anchor comparison is `thread_item_anchor.id::text = $6::text`, so a non-uuid
// string currently just fails to match and surfaces the friendly ToolError
// ("Channel or message anchor is no longer available"). Under $6::uuid it would
// instead blow up as a raw Postgres cast error. Keeping the parameter as text
// preserves the existing comparison semantics exactly.
//
// WHY THIS TEST IS STATIC, AND WHAT THAT DOES NOT PROVE. This asserts on the SQL
// TEXT, not on a live database. That is deliberate and it is also the honest
// limit of it: a mocked db cannot reproduce this bug at all, because the failure
// lives in the real planner's parse step. A mock happily "executes" the broken
// statement and returns a row, so a mock-based regression test here would be
// vacuous — it would pass just as green before the fix as after it.
//
// What this test DOES do is fail if anyone reintroduces a bare, uncast $6 in the
// insert. That is the exact shape of the regression, and it is catchable from
// source. End-to-end proof requires a real Postgres and belongs in a live probe,
// not here.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const MCP_SOURCE = fs.readFileSync(
 path.join(__dirname, '..', 'server', 'mcp.cjs'),
 'utf8',
);

// Narrow to the create_thread_item insert so unrelated $6 uses elsewhere in the
// file cannot make this pass or fail by accident.
function threadItemInsertSql() {
 const start = MCP_SOURCE.indexOf('insert into thread_items');
 assert.notStrictEqual(
  start, -1,
  'create_thread_item insert not found — did the tool move or get renamed?',
 );
 const end = MCP_SOURCE.indexOf('returning *', start);
 assert.notStrictEqual(end, -1, 'insert statement has no returning clause');
 return MCP_SOURCE.slice(start, end);
}

test('create_thread_item never uses a bare $6 in its select list', () => {
 const sql = threadItemInsertSql();
 const selectLine = sql
  .split('\n')
  .find(line => line.includes('select $1'));
 assert.ok(selectLine, 'insert has no select-list line starting at $1');

 // A bare $6 here is deduced as uuid from the message_id column while the
 // where-clause deduces it as text. That combination does not parse.
 assert.ok(
  !/[^:]\$6\s*,/.test(selectLine),
  `create_thread_item select list uses an uncast $6, which makes Postgres deduce `
  + `uuid here and text in the where clause — the statement will not parse and `
  + `EVERY call to the tool fails. Cast it: nullif($6::text, '')::uuid\n`
  + `  got: ${selectLine.trim()}`,
 );

 assert.ok(
  selectLine.includes("nullif($6::text, '')::uuid"),
  `expected the message_id value to be pinned to text and converted at the `
  + `insert site\n  got: ${selectLine.trim()}`,
 );
});

test('create_thread_item still guards the anchor with text comparison', () => {
 const sql = threadItemInsertSql();

 // If these ever become ::uuid, the parameter is uuid-typed again and a
 // malformed message_id turns a friendly ToolError into a raw cast error.
 assert.ok(
  sql.includes('$6::text is null'),
  'lost the null-anchor short circuit, or it stopped being ::text',
 );
 assert.ok(
  sql.includes('thread_item_anchor.id::text = $6::text'),
  'anchor comparison must stay text-to-text so a malformed message_id misses '
  + 'the match instead of raising a Postgres cast error',
 );
});

test('every $6 in the thread_items insert carries an explicit cast', () => {
 const sql = threadItemInsertSql();
 const occurrences = sql.match(/\$6(::\w+)?/g) || [];
 assert.ok(occurrences.length >= 3, `expected $6 to appear at least 3 times, saw ${occurrences.length}`);
 for (const occurrence of occurrences) {
  assert.ok(
   occurrence.startsWith('$6::'),
   `found an uncast "${occurrence}" — mixed deduction is what broke this tool`,
  );
 }
});
