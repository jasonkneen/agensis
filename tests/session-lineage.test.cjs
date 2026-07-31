'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
 installCreatedSessionMemberships,
 normalizeSessionCreateRow,
 prepareSessionCreateRows,
 projectSessionCreateRows,
 sessionLineageKind,
} = require('../shared/session-lineage.cjs');

const USER_ID = '00000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const OTHER_WORKSPACE_ID = '00000000-0000-4000-8000-000000000003';
const PARENT_ID = '00000000-0000-4000-8000-000000000004';
const MESSAGE_ID = '00000000-0000-4000-8000-000000000005';
const CHILD_ID = '00000000-0000-4000-8000-000000000006';

function parent(overrides = {}) {
 return {
  id: PARENT_ID,
  workspace_id: WORKSPACE_ID,
  title: 'Parent',
  model: 'auto',
  folder: 'Direct messages',
  description: 'source',
  icon: 'lock',
  intent: 'Keep this private',
  participants: [{ id: 'agent:a', kind: 'agent' }],
  conversation_mode: 'auto',
  max_agent_turns: 10,
  auto_rounds: 3,
  canvas_id: null,
  visibility: 'private',
  deleted_at: null,
  ...overrides,
 };
}

function authorizedDeps() {
 const calls = { roles: [], reads: [] };
 return {
  calls,
  assertRole: async (input) => { calls.roles.push(input); },
  enforceRead: async (input) => { calls.reads.push(input); },
 };
}

test('session lineage rejects an ambiguous parent edge', () => {
 assert.throws(
  () => sessionLineageKind({ parent_message_id: MESSAGE_ID, split_parent_id: PARENT_ID }),
  /only one parent/,
 );
});

test('root normalization strips server-owned lifecycle fields and fails closed for DMs', () => {
 const row = normalizeSessionCreateRow({
  workspace_id: WORKSPACE_ID,
  folder: 'Direct messages',
  visibility: 'workspace',
  deleted_at: '2026-01-01T00:00:00.000Z',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  version: 99,
  split_at: '2026-01-01T00:00:00.000Z',
 });
 assert.equal(row.visibility, 'private');
 assert.equal('deleted_at' in row, false);
 assert.equal('created_at' in row, false);
 assert.equal('updated_at' in row, false);
 assert.equal('version' in row, false);
 assert.equal('split_at' in row, false);
});

test('root normalization stores only canonical visibility and reserved DM folder values', () => {
 assert.deepEqual(
  normalizeSessionCreateRow({
   workspace_id: WORKSPACE_ID,
   folder: ' Direct messages ',
   visibility: ' workspace ',
  }),
  {
   workspace_id: WORKSPACE_ID,
   folder: 'Direct messages',
   visibility: 'private',
  },
 );
 assert.equal(
  normalizeSessionCreateRow({
   workspace_id: WORKSPACE_ID,
   visibility: ' private ',
  }).visibility,
  'private',
 );
 assert.equal(
  Object.hasOwn(normalizeSessionCreateRow({
   workspace_id: WORKSPACE_ID,
   visibility: '   ',
  }), 'visibility'),
  false,
 );
});

test('conversation creation rejects batches before taking authorization locks', async () => {
 const deps = authorizedDeps();
 await assert.rejects(
  prepareSessionCreateRows({
   db: async () => { throw new Error('batch creation must not query'); },
   userId: USER_ID,
   rows: [
    { workspace_id: WORKSPACE_ID, title: 'One' },
    { workspace_id: WORKSPACE_ID, title: 'Two' },
   ],
   ...deps,
  }),
  /one conversation at a time/i,
 );
 assert.equal(deps.calls.roles.length, 0);
});

test('root creation rechecks write authority inside the command', async () => {
 const { calls, assertRole, enforceRead } = authorizedDeps();
 const result = await prepareSessionCreateRows({
  db: async () => { throw new Error('root creation should not query lineage'); },
  userId: USER_ID,
  rows: [{ workspace_id: WORKSPACE_ID, title: 'Channel' }],
  assertRole,
  enforceRead,
 });
 assert.equal(result.rows[0].title, 'Channel');
 assert.deepEqual(result.lineage, [{ kind: 'root', parentSessionId: null }]);
 assert.equal(calls.roles.length, 1);
 assert.equal(calls.roles[0].capability, 'write');
 assert.equal(calls.roles[0].workspaceId, WORKSPACE_ID);
 assert.equal(calls.reads.length, 0);
});

test('split creation rejects cross-workspace lineage without authorizing the foreign parent', async () => {
 const { calls, assertRole, enforceRead } = authorizedDeps();
 await assert.rejects(
  prepareSessionCreateRows({
   db: async (sql) => sql.includes('from chat_sessions s') ? [parent({ workspace_id: OTHER_WORKSPACE_ID })] : [],
   userId: USER_ID,
   rows: [{ workspace_id: WORKSPACE_ID, split_parent_id: PARENT_ID }],
   assertRole,
   enforceRead,
 }),
  /Parent conversation is unavailable/,
 );
 assert.equal(calls.roles.length, 1);
 assert.equal(calls.roles[0].workspaceId, WORKSPACE_ID);
 assert.equal(calls.reads.length, 0);
});

test('deleted or missing split parents fail closed', async () => {
 const deps = authorizedDeps();
 await assert.rejects(
  prepareSessionCreateRows({
   db: async (sql) => {
    assert.match(sql, /s\.deleted_at is null/);
    assert.match(sql, /for share of s/i);
    return [];
   },
   userId: USER_ID,
   rows: [{ workspace_id: WORKSPACE_ID, split_parent_id: PARENT_ID }],
   ...deps,
  }),
  /Parent conversation is unavailable/,
 );
});

test('subthread lookup requires both a live message and a live parent session', async () => {
 const deps = authorizedDeps();
 const seen = [];
 await assert.rejects(
  prepareSessionCreateRows({
   db: async (sql) => {
    seen.push(sql);
    if (/select m\.session_id/.test(sql)) return [{ session_id: PARENT_ID }];
    if (/from chat_sessions s/.test(sql)) return [parent()];
    return [];
   },
   userId: USER_ID,
   rows: [{ workspace_id: WORKSPACE_ID, parent_message_id: MESSAGE_ID }],
   ...deps,
  }),
  /Parent conversation is unavailable/,
 );
 assert.ok(seen.some(sql => /m\.deleted_at is null/.test(sql)));
 assert.ok(seen.some(sql => /s\.deleted_at is null/.test(sql) && /for share of s/i.test(sql)));
 assert.ok(seen.some(sql => /m\.session_id = \$2::uuid/.test(sql) && /for share of m/i.test(sql)));
});

test('a private split inherits security and behavior from the locked parent', async () => {
 const deps = authorizedDeps();
 const seenSql = [];
 const db = async (sql) => {
  seenSql.push(sql);
  if (sql.includes('from chat_sessions s')) return [parent()];
  if (sql.includes('from chat_session_members')) return [{ user_id: USER_ID }];
  throw new Error(`Unexpected SQL: ${sql}`);
 };
 const result = await prepareSessionCreateRows({
  db,
  userId: USER_ID,
  rows: [{
   workspace_id: WORKSPACE_ID,
   split_parent_id: PARENT_ID,
   title: 'Fork',
   visibility: 'workspace',
   canvas_id: 'attacker-canvas',
   participants: [{ id: 'agent:attacker', kind: 'agent' }],
   folder: 'General',
  }],
  now: () => new Date('2026-07-31T12:00:00.000Z'),
  ...deps,
 });
 const [row] = result.rows;
 assert.equal(row.visibility, 'private');
 assert.equal(row.canvas_id, null);
 assert.equal(row.folder, 'Direct messages');
 assert.deepEqual(row.participants, parent().participants);
 assert.equal(row.intent, 'Keep this private');
 assert.equal(row.split_at, '2026-07-31T12:00:00.000Z');
 assert.deepEqual(result.lineage, [{ kind: 'split', parentSessionId: PARENT_ID }]);
 assert.equal(deps.calls.roles.length, 1);
 assert.equal(deps.calls.reads.length, 1);
 assert.ok(seenSql.some(sql => sql.includes('for share')));
});

test('a private derivative cannot race a membership revoke', async () => {
 const deps = authorizedDeps();
 await assert.rejects(
  prepareSessionCreateRows({
   db: async (sql) => {
    if (sql.includes('from chat_sessions s')) return [parent()];
    if (sql.includes('from chat_session_members')) return [];
    throw new Error(`Unexpected SQL: ${sql}`);
   },
   userId: USER_ID,
   rows: [{ workspace_id: WORKSPACE_ID, split_parent_id: PARENT_ID }],
   ...deps,
  }),
  (error) => error?.status === 403 && /do not have access/.test(error.message),
 );
});

test('a subthread inherits scope but retains its explicitly selected agent roster', async () => {
 const deps = authorizedDeps();
 const selected = [{ id: 'agent:selected', kind: 'agent' }];
 const result = await prepareSessionCreateRows({
  db: async (sql) => {
   if (/select m\.session_id/.test(sql)) return [{ session_id: PARENT_ID }];
   if (sql.includes('from chat_sessions s')) {
    return [parent({ folder: 'General', visibility: 'workspace', canvas_id: 'canvas-a' })];
   }
   if (/select m\.id/.test(sql)) return [{ id: MESSAGE_ID }];
   throw new Error(`Unexpected SQL: ${sql}`);
  },
  userId: USER_ID,
  rows: [{
   workspace_id: WORKSPACE_ID,
   parent_message_id: MESSAGE_ID,
   folder: 'Direct messages',
   visibility: 'private',
   canvas_id: 'canvas-b',
   participants: selected,
  }],
  ...deps,
 });
 assert.equal(result.rows[0].folder, 'sub-thread');
 assert.equal(result.rows[0].visibility, 'workspace');
 assert.equal(result.rows[0].canvas_id, 'canvas-a');
 assert.deepEqual(result.rows[0].participants, selected);
});

test('private member installation copies the live parent roster without elevating the creator', async () => {
 const calls = [];
 await installCreatedSessionMemberships({
  db: async (sql, params) => { calls.push({ sql, params }); return []; },
  userId: USER_ID,
  createdRows: [{ id: CHILD_ID, visibility: 'private', folder: 'sub-thread' }],
  lineage: [{ kind: 'subthread', parentSessionId: PARENT_ID }],
 });
 assert.equal(calls.length, 1);
 assert.deepEqual(calls[0].params, [CHILD_ID, PARENT_ID]);
 assert.match(calls[0].sql, /on conflict \(session_id, user_id\) do nothing/i);
 assert.match(calls[0].sql, /members\.expires_at > now\(\)/i);
 assert.match(calls[0].sql, /members\.source/i);
 assert.match(calls[0].sql, /members\.granted_by/i);
 assert.doesNotMatch(calls[0].sql, /'participant'/i);
});

test('a private root installs only its creator as an intrinsic participant', async () => {
 const calls = [];
 await installCreatedSessionMemberships({
  db: async (sql, params) => { calls.push({ sql, params }); return []; },
  userId: USER_ID,
  createdRows: [{ id: CHILD_ID, visibility: 'private', folder: 'Direct messages' }],
  lineage: [{ kind: 'root', parentSessionId: null }],
 });
 assert.equal(calls.length, 1);
 assert.deepEqual(calls[0].params, [CHILD_ID, USER_ID]);
 assert.match(calls[0].sql, /'participant', null, null/i);
});

test('membership installation failure propagates so the caller can roll back the INSERT', async () => {
 await assert.rejects(
  installCreatedSessionMemberships({
   db: async () => { throw new Error('membership write failed'); },
   userId: USER_ID,
   createdRows: [{ id: CHILD_ID, visibility: 'private', folder: 'sub-thread' }],
   lineage: [{ kind: 'subthread', parentSessionId: PARENT_ID }],
  }),
  /membership write failed/,
 );
});

test('public roots do not create unnecessary member rows', async () => {
 let called = false;
 await installCreatedSessionMemberships({
  db: async () => { called = true; return []; },
  userId: USER_ID,
  createdRows: [{ id: CHILD_ID, visibility: 'workspace', folder: 'General' }],
  lineage: [{ kind: 'root', parentSessionId: null }],
 });
 assert.equal(called, false);
});

test('internal full-row settlement still honors the caller response projection', () => {
 const rows = [{ id: CHILD_ID, title: 'Child', visibility: 'private', folder: 'sub-thread' }];
 assert.deepEqual(projectSessionCreateRows(rows, 'id,title'), [{ id: CHILD_ID, title: 'Child' }]);
 const projectedAll = projectSessionCreateRows(rows, '*');
 assert.equal(projectedAll[0].id, CHILD_ID);
 assert.equal(projectedAll[0].title, 'Child');
 assert.equal(projectedAll[0].visibility, 'private');
 assert.equal(projectedAll[0].folder, 'sub-thread');
 assert.equal(Object.hasOwn(projectedAll[0], 'connect_token_hash'), false);
 assert.throws(
  () => projectSessionCreateRows(rows, 'id,(select secret)'),
  /not selectable/,
 );
});

test('Fly and Netlify route chat session inserts through the same transactional command', () => {
 const root = path.join(__dirname, '..');
 const fly = fs.readFileSync(path.join(root, 'server/index.cjs'), 'utf8');
 const netlify = fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8');
 for (const [name, source] of [['Fly', fly], ['Netlify', netlify]]) {
  assert.match(source, /prepareSessionCreateRows\(\{/,
   `${name} must resolve and authorize lineage through the shared command`);
  assert.match(source, /installCreatedSessionMemberships\(\{/,
   `${name} must install private membership before returning`);
  assert.match(source, /table === 'chat_sessions'/,
   `${name} must specialize chat_sessions`);
  assert.match(source, /projectSessionCreateRows\(\[\], returning\)/,
   `${name} must reject an invalid response projection before writing`);
 }
 assert.match(fly, /getDb\(\)\.begin\(/,
  'Fly must create the session and member graph in one transaction');
 assert.match(netlify, /withDbTransaction\(insertRows\)/,
  'Netlify must create the session and member graph in one transaction');
 assert.match(netlify, /await client\.query\('COMMIT'\)/,
  'Netlify must not emulate a transaction with unrelated pool queries');
});
