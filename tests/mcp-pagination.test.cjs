'use strict';

// ============================================================================
// tests/mcp-pagination.test.cjs
// ----------------------------------------------------------------------------
// Keyset pagination on the MCP read tools.
//
// The bug being closed was not "you cannot get page 2". It was that a full page
// was INDISTINGUISHABLE from a complete answer: a list tool returned the newest
// 50 rows and said nothing about the rest, so `npm run ops` — and every other
// MCP client — reported a truncated list as though it were the whole workspace.
//
// NON-VACUITY. The fake db here does NOT implement pagination. It returns
// whatever rows the test hands it and RECORDS the SQL, so every assertion is
// against the statement the real tool built and the value the real tool
// returned. A fake that filtered by the cursor itself would be testing the fake.
//
// The load-bearing case is `(timestamp, id)`, not `timestamp` alone: two rows
// written in the same millisecond share a timestamp, and a strict `<` on the
// bare column skips one of them at the page boundary while `<=` repeats one.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler, __test } = require('../server/mcp.cjs');
const { encodeCursor, decodeCursor, keysetClause, nextCursor } = __test;

const WS = 'ws-1';
const AGENT = {
 kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder',
 agent: { model: 'claude-opus-4-8', description: 'coding agent' },
};

/** Returns `rows` for any select and records every statement issued. */
function makeDb(rows = []) {
 const db = {
  calls: [],
  async unsafe(sql, params = []) {
   const n = String(sql).replace(/\s+/g, ' ').trim();
   db.calls.push({ sql: n, lower: n.toLowerCase(), params });
   if (db.calls.length === 1 && /^select id from chat_sessions/i.test(n)) return [{ id: 'ch-1' }];
   if (/^select id from chat_sessions/i.test(n)) return [{ id: 'ch-1' }];
   return rows;
  },
 };
 return db;
}

const { __test: indexTest } = require('../server/index.cjs');

function makeDeps(db) {
 return {
  getDb: () => db,
  verifyMcpToken: async (token) => (token === 'good' ? AGENT : null),
  continueConversation: async () => {},
  notifyDbSubscribers: () => {},
  slugHandle: (s) => String(s || '').toLowerCase().replace(/\s+/g, '-'),
  claimMcpJob: async () => null,
  submitMcpJobResult: async () => ({ jobId: 'x', status: 'done' }),
  resolveWorkspaceAgentByHandle: async () => null,
  registerAgentRequest: async () => ({ registrationId: 'reg-1', status: 'approved', handle: 'coder' }),
  getRegistrationStatus: async () => ({ registrationId: 'reg-1', status: 'approved', agentId: 'agent-1', handle: 'coder' }),
  roleHasWorkspaceCapability: indexTest.roleHasWorkspaceCapability,
  rateLimiter: null,
  rateLimitBlocked: null,
  runtimeSchemaReady: Promise.resolve(),
  serverVersion: '9.9.9',
 };
}

async function callTool(name, args, rows) {
 const db = makeDb(rows);
 const handler = createMcpHandler(makeDeps(db));
 const res = {
  statusCode: 200, body: null, headers: {},
  status(code) { this.statusCode = code; return this; },
  json(value) { this.body = value; return this; },
  setHeader(k, v) { this.headers[k] = v; },
  end() { return this; },
 };
 await handler(
  { headers: { authorization: 'Bearer good' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, url: '/backend/mcp' },
  res,
 );
 const text = res.body?.result?.content?.[0]?.text;
 return { db, value: text ? JSON.parse(text) : null, res };
}

/** The paginated statement — the last select, past any scope preflight. */
function pagedCall(db) {
 return [...db.calls].reverse().find((c) => c.lower.startsWith('select'));
}

function rowsOf(count, { at = '2026-07-30T10:00:00.000Z' } = {}) {
 return Array.from({ length: count }, (unused, i) => ({
  id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
  title: `row ${i}`,
  content: 'x',
  created_at: at,
  updated_at: at,
 }));
}

// --- the cursor itself -------------------------------------------------------

test('a cursor round-trips, and garbage decodes to null rather than throwing', () => {
 const row = { id: 'abc', created_at: '2026-07-30T10:00:00.000Z' };
 const token = encodeCursor(row, 'created_at');
 assert.deepEqual(decodeCursor(token), { at: '2026-07-30T10:00:00.000Z', id: 'abc' });

 // A truncated copy-paste must yield the FIRST page, not a dead end. The cursor
 // grants nothing — every query still carries its own workspace predicate — so
 // there is nothing protected by refusing.
 for (const bad of [undefined, null, '', '   ', 'not-base64!!', Buffer.from('{}').toString('base64url'),
  Buffer.from(JSON.stringify({ at: 'nonsense', id: 'x' })).toString('base64url')]) {
  assert.equal(decodeCursor(bad), null, `${String(bad)} must decode to null`);
 }
});

test('a Date column encodes as an ISO string, not as "[object Date]"', () => {
 // pg drivers hand back Date objects for timestamptz. String(date) would
 // produce a local-time human string that Date.parse then reads back in the
 // wrong zone, silently shifting the page boundary by hours.
 const token = encodeCursor({ id: 'abc', created_at: new Date('2026-07-30T10:00:00.000Z') }, 'created_at');
 assert.deepEqual(decodeCursor(token), { at: '2026-07-30T10:00:00.000Z', id: 'abc' });
});

test('a row with no id or no timestamp yields no cursor', () => {
 // Better no cursor than one that decodes to `undefined` and pages from the
 // epoch, which would return the whole table as "page 2".
 assert.equal(encodeCursor({ id: 'a' }, 'created_at'), null);
 assert.equal(encodeCursor({ created_at: '2026-07-30T10:00:00.000Z' }, 'created_at'), null);
 assert.equal(encodeCursor(null, 'created_at'), null);
});

test('the clause compares the PAIR, and binds rather than interpolates', () => {
 // MUTATION: drop `id` from the comparison -> this fails, and the real query
 // starts skipping rows that share a timestamp with the last row of a page.
 const params = ['ws-1'];
 const clause = keysetClause({ at: '2026-07-30T10:00:00.000Z', id: 'abc' }, 'm.created_at', params, 'm.id');
 assert.match(clause, /\(m\.created_at, m\.id\) < \(\$2::timestamptz, \$3::uuid\)/);
 assert.deepEqual(params, ['ws-1', '2026-07-30T10:00:00.000Z', 'abc']);
 // No cursor means no clause AND no binds, so the caller can interpolate it
 // unconditionally without shifting its own parameter numbering.
 const untouched = ['ws-1'];
 assert.equal(keysetClause(null, 'created_at', untouched), '');
 assert.deepEqual(untouched, ['ws-1']);
});

test('a SHORT page offers no cursor, because there is nothing behind it', () => {
 // Handing out a cursor here would invite a request that always returns
 // nothing, which reads as an error rather than as the end of the list.
 assert.equal(nextCursor(rowsOf(3), 50, 'created_at'), null);
 assert.equal(nextCursor([], 50, 'created_at'), null);
 assert.ok(nextCursor(rowsOf(50), 50, 'created_at'));
});

// --- the tools ---------------------------------------------------------------

const PAGINATED = [
 ['list_channels', {}, 'channels', 'updated_at'],
 ['list_docs', {}, 'documents', 'updated_at'],
 ['list_tasks', {}, 'tasks', 'created_at'],
 ['search_messages', { query: 'x' }, 'results', 'created_at'],
 ['search_docs', { query: 'x' }, 'results', 'updated_at'],
 ['read_channel', { channel_id: 'ch-1' }, 'messages', 'created_at'],
];

for (const [name, args, key, field] of PAGINATED) {
 test(`${name} orders by (${field}, id) so a cursor cannot skip a row`, async () => {
  // MUTATION: drop `, id desc` from the order by -> this fails. The tiebreak is
  // what makes the keyset total; without it the comparison is against a
  // non-unique column and rows sharing a timestamp fall through the boundary.
  const { db } = await callTool(name, args, rowsOf(3));
  const call = pagedCall(db);
  assert.match(call.lower, new RegExp(`order by [a-z.]*${field} desc, [a-z.]*id desc`));
 });

 test(`${name} says whether there is more`, async () => {
  const short = await callTool(name, args, rowsOf(3));
  assert.equal(short.value.next_cursor, null, 'a short page is the last page');

  // A FULL page (the tool's default of 50, or its own cap) must offer one. The
  // silent-truncation bug is exactly this value being absent.
  const full = await callTool(name, { ...args, limit: 3 }, rowsOf(3));
  assert.ok(full.value.next_cursor, 'a full page must carry a cursor');
  assert.ok(decodeCursor(full.value.next_cursor), 'and it must be a readable one');
 });

 test(`${name} passes a cursor into the SQL as a keyset comparison`, async () => {
  // MUTATION: ignore args.cursor -> no comparison appears and this fails, so
  // every "next page" would return page 1 again, forever.
  const cursor = encodeCursor({ id: '00000000-0000-4000-8000-000000000009', created_at: '2026-07-30T09:00:00.000Z' }, 'created_at');
  const { db } = await callTool(name, { ...args, cursor }, rowsOf(3));
  const call = pagedCall(db);
  assert.match(call.lower, /\) < \(\$\d+::timestamptz, \$\d+::uuid\)/);
  assert.ok(call.params.includes('2026-07-30T09:00:00.000Z'), 'the cursor timestamp must be BOUND, not interpolated');
  assert.ok(call.params.includes('00000000-0000-4000-8000-000000000009'));
 });

 test(`${name} treats an unreadable cursor as the first page`, async () => {
  const { db, value } = await callTool(name, { ...args, cursor: 'not-a-real-cursor' }, rowsOf(3));
  assert.equal(pagedCall(db).lower.includes('::timestamptz'), false);
  assert.ok(value, 'and it must still answer rather than erroring');
 });

 test(`${name} advertises the cursor in its input schema`, async () => {
  // A tool that accepts a cursor but does not declare it is a tool no MCP
  // client can discover — which is the state the whole surface was in.
  const db = makeDb([]);
  const handler = createMcpHandler(makeDeps(db));
  const res = {
   statusCode: 200, body: null, status(c) { this.statusCode = c; return this; },
   json(v) { this.body = v; return this; }, setHeader() {}, end() { return this; },
  };
  await handler(
   { headers: { authorization: 'Bearer good' }, body: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, url: '/backend/mcp' },
   res,
  );
  const tool = res.body.result.tools.find((t) => t.name === name);
  assert.ok(tool, `${name} must be listed`);
  assert.equal(tool.inputSchema.properties.cursor?.type, 'string');
 });
}

test('read_channel builds its cursor from the OLDEST message, not the newest', async () => {
 // read_channel selects newest-first and then REVERSES for display. The cursor
 // must come from the DESC page's last row — the oldest returned — because that
 // is where the next (older) page starts. Taking it after the reverse points at
 // the newest message, and every "next page" returns the same rows forever.
 //
 // MUTATION: move the nextCursor() call after `rows.reverse()` -> this fails.
 const rows = [
  { id: 'aaaaaaaa-0000-4000-8000-000000000001', content: 'newest', created_at: '2026-07-30T12:00:00.000Z' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000002', content: 'middle', created_at: '2026-07-30T11:00:00.000Z' },
  { id: 'aaaaaaaa-0000-4000-8000-000000000003', content: 'oldest', created_at: '2026-07-30T10:00:00.000Z' },
 ];
 const { value } = await callTool('read_channel', { channel_id: 'ch-1', limit: 3 }, rows);
 assert.equal(value.messages[0].content, 'oldest', 'output stays oldest-first');
 assert.deepEqual(decodeCursor(value.next_cursor), {
  at: '2026-07-30T10:00:00.000Z',
  id: 'aaaaaaaa-0000-4000-8000-000000000003',
 });
});
