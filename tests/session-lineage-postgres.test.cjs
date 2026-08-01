'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
 installCreatedSessionMemberships,
 prepareSessionCreateRows,
} = require('../shared/session-lineage.cjs');

const DATABASE_URL = String(process.env.AGENSIS_TEST_DATABASE_URL || '');
const integrationTest = DATABASE_URL ? test : test.skip;

integrationTest('real PostgreSQL keeps private lineage and membership in one transaction', async () => {
 const postgres = require('postgres');
 const sql = postgres(DATABASE_URL, { max: 3, onnotice: () => {} });
 const schema = `agensis_lineage_${crypto.randomBytes(8).toString('hex')}`;
 const quotedSchema = `"${schema}"`;
 const userId = '10000000-0000-4000-8000-000000000001';
 const peerId = '10000000-0000-4000-8000-000000000002';
 const workspaceId = '10000000-0000-4000-8000-000000000003';
 const otherWorkspaceId = '10000000-0000-4000-8000-000000000004';
 const parentId = '10000000-0000-4000-8000-000000000005';
 const parentMessageId = '10000000-0000-4000-8000-000000000006';
 const childId = '10000000-0000-4000-8000-000000000007';
 const rolledBackId = '10000000-0000-4000-8000-000000000008';
 const raceChildId = '10000000-0000-4000-8000-000000000009';
 const lockedRootId = '10000000-0000-4000-8000-000000000010';
 const deniedRootId = '10000000-0000-4000-8000-000000000011';
 const ownerId = '10000000-0000-4000-8000-000000000012';

 const query = (connection) => (text, params = []) => connection.unsafe(text, params);
 try {
  await sql.unsafe(`create schema ${quotedSchema}`);
  await sql.unsafe(`
   create table ${quotedSchema}.workspaces (
    id uuid primary key,
    parent_id uuid references ${quotedSchema}.workspaces(id),
    user_id uuid not null
   );
   create table ${quotedSchema}.workspace_members (
    workspace_id uuid not null references ${quotedSchema}.workspaces(id),
    user_id uuid not null,
    role text not null,
    primary key (workspace_id, user_id)
   );
   create table ${quotedSchema}.chat_sessions (
    id uuid primary key,
    workspace_id uuid not null,
    title text not null default 'New Chat',
    model text default 'auto',
    folder text default 'General',
    description text not null default '',
    icon text not null default '',
    intent text not null default '',
    participants jsonb not null default '[]'::jsonb,
    conversation_mode text not null default 'auto',
    max_agent_turns integer not null default 10,
    auto_rounds integer not null default 3,
    parent_message_id uuid,
    split_parent_id uuid,
    split_at timestamptz,
    deleted_at timestamptz,
    canvas_id text,
    visibility text not null default 'workspace',
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
   );
   create table ${quotedSchema}.messages (
    id uuid primary key,
    session_id uuid not null references ${quotedSchema}.chat_sessions(id),
    content text not null default '',
    deleted_at timestamptz
   );
   alter table ${quotedSchema}.chat_sessions
    add constraint lineage_parent_message_fkey
    foreign key (parent_message_id) references ${quotedSchema}.messages(id);
   alter table ${quotedSchema}.chat_sessions
    add constraint lineage_split_parent_fkey
    foreign key (split_parent_id) references ${quotedSchema}.chat_sessions(id);
   create table ${quotedSchema}.chat_session_members (
    session_id uuid not null references ${quotedSchema}.chat_sessions(id),
    user_id uuid not null,
    source text not null default 'participant',
    granted_by uuid,
    expires_at timestamptz,
    created_at timestamptz not null default now(),
    primary key (session_id, user_id)
   )
  `);
  await sql.unsafe(
   `insert into ${quotedSchema}.workspaces (id, user_id)
    values ($1, $3), ($2, $3)`,
   [workspaceId, otherWorkspaceId, ownerId],
  );
  await sql.unsafe(
   `insert into ${quotedSchema}.workspace_members (workspace_id, user_id, role)
    values ($1, $3, 'editor'), ($2, $3, 'editor')`,
   [workspaceId, otherWorkspaceId, userId],
  );
  await sql.unsafe(
   `insert into ${quotedSchema}.chat_sessions
      (id, workspace_id, title, folder, participants, canvas_id, visibility)
    values ($1, $2, 'Private parent', 'Direct messages',
            '[{"id":"agent:one","kind":"agent"}]'::jsonb, null, 'private')`,
   [parentId, workspaceId],
  );
  await sql.unsafe(
   `insert into ${quotedSchema}.messages (id, session_id, content)
    values ($1, $2, 'source')`,
   [parentMessageId, parentId],
  );
  await sql.unsafe(
   `insert into ${quotedSchema}.chat_session_members
      (session_id, user_id, source, granted_by, expires_at)
    values ($1, $2, 'grant', $4, now() + interval '1 day'),
           ($1, $3, 'participant', null, null)`,
   [parentId, userId, peerId, ownerId],
  );

  await sql.begin(async (transaction) => {
   await transaction.unsafe(`set local search_path to ${quotedSchema}`);
   const db = query(transaction);
   const prepared = await prepareSessionCreateRows({
    db,
    userId,
    rows: [{
     id: childId,
     workspace_id: workspaceId,
     parent_message_id: parentMessageId,
     title: 'Subthread',
     folder: 'General',
     visibility: 'workspace',
     participants: [{ id: 'agent:two', kind: 'agent' }],
    }],
    enforceRead: async () => {},
   });
   const row = prepared.rows[0];
   const inserted = await db(
    `insert into chat_sessions
       (id, workspace_id, title, folder, participants, parent_message_id,
        canvas_id, visibility)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)
     returning *`,
    [
     row.id, row.workspace_id, row.title, row.folder,
     row.participants, row.parent_message_id, row.canvas_id, row.visibility,
    ],
   );
   await installCreatedSessionMemberships({
    db,
    userId,
    createdRows: inserted,
    lineage: prepared.lineage,
   });
  });

  const children = await sql.unsafe(
   `select folder, visibility, canvas_id
      from ${quotedSchema}.chat_sessions where id = $1`,
   [childId],
  );
  assert.deepEqual(
   { folder: children[0].folder, visibility: children[0].visibility, canvas_id: children[0].canvas_id },
   { folder: 'sub-thread', visibility: 'private', canvas_id: null },
  );
  const members = await sql.unsafe(
   `select user_id::text, source, granted_by::text, expires_at is not null as expires
      from ${quotedSchema}.chat_session_members
     where session_id = $1 order by user_id::text`,
   [childId],
  );
  assert.deepEqual(members.map((row) => row.user_id), [userId, peerId]);
  assert.deepEqual(
   members.map(({ source, granted_by, expires }) => ({ source, granted_by, expires })),
   [
    { source: 'grant', granted_by: ownerId, expires: true },
    { source: 'participant', granted_by: null, expires: false },
   ],
  );

  await assert.rejects(
   sql.begin(async (transaction) => {
    await transaction.unsafe(`set local search_path to ${quotedSchema}`);
    const db = query(transaction);
    const prepared = await prepareSessionCreateRows({
     db,
     userId,
     rows: [{
      id: rolledBackId,
      workspace_id: workspaceId,
      folder: 'Direct messages',
      title: 'Must roll back',
     }],
     enforceRead: async () => {},
    });
    const inserted = await db(
     `insert into chat_sessions (id, workspace_id, title, folder, visibility)
      values ($1, $2, $3, $4, $5) returning *`,
     [
      prepared.rows[0].id, prepared.rows[0].workspace_id,
      prepared.rows[0].title, prepared.rows[0].folder,
      prepared.rows[0].visibility,
     ],
    );
    await installCreatedSessionMemberships({
     db: async (text, params) => {
      if (/insert into chat_session_members/i.test(text)) throw new Error('forced membership failure');
      return db(text, params);
     },
     userId,
     createdRows: inserted,
     lineage: prepared.lineage,
    });
   }),
   /forced membership failure/,
  );
  const rolledBack = await sql.unsafe(
   `select id from ${quotedSchema}.chat_sessions where id = $1`,
   [rolledBackId],
  );
  assert.equal(rolledBack.length, 0);

  await assert.rejects(
   sql.begin(async (transaction) => {
    await transaction.unsafe(`set local search_path to ${quotedSchema}`);
    await prepareSessionCreateRows({
     db: query(transaction),
     userId,
     rows: [{ workspace_id: otherWorkspaceId, split_parent_id: parentId }],
     enforceRead: async () => {},
    });
   }),
   /Parent conversation is unavailable/,
  );

  // The complete parent roster is locked before the child snapshot is copied.
  // A concurrent revoke therefore has one of two serial outcomes. Here child
  // creation wins: the revoke waits for its commit, and the child keeps the
  // roster that was live at that boundary.
  let releaseRosterCreate;
  const holdRosterCreate = new Promise((resolve) => { releaseRosterCreate = resolve; });
  let rosterPrepared;
  const rosterPreparedSignal = new Promise((resolve) => { rosterPrepared = resolve; });
  const rosterCreate = sql.begin(async (transaction) => {
   await transaction.unsafe(`set local search_path to ${quotedSchema}`);
   const db = query(transaction);
   const prepared = await prepareSessionCreateRows({
    db,
    userId,
    rows: [{
     id: raceChildId,
     workspace_id: workspaceId,
     split_parent_id: parentId,
     title: 'Roster boundary',
    }],
    enforceRead: async () => {},
   });
   const row = prepared.rows[0];
   const inserted = await db(
    `insert into chat_sessions
       (id, workspace_id, title, model, folder, description, icon, intent,
        participants, conversation_mode, max_agent_turns, auto_rounds,
        split_parent_id, split_at, canvas_id, visibility)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12,
             $13, $14, $15, $16)
     returning *`,
    [
     row.id, row.workspace_id, row.title, row.model, row.folder,
     row.description, row.icon, row.intent, row.participants,
     row.conversation_mode, row.max_agent_turns, row.auto_rounds,
     row.split_parent_id, row.split_at, row.canvas_id, row.visibility,
    ],
   );
   await installCreatedSessionMemberships({
    db,
    userId,
    createdRows: inserted,
    lineage: prepared.lineage,
   });
   rosterPrepared();
   await holdRosterCreate;
  });
  await rosterPreparedSignal;
  let rosterRevokeAttempted;
  const rosterRevokeAttemptedSignal = new Promise((resolve) => { rosterRevokeAttempted = resolve; });
  const rosterRevoke = sql.begin(async (transaction) => {
   await transaction.unsafe(`set local search_path to ${quotedSchema}`);
   const deletion = transaction.unsafe(
    'delete from chat_session_members where session_id = $1 and user_id = $2',
    [parentId, peerId],
   );
   rosterRevokeAttempted();
   await deletion;
  });
  await rosterRevokeAttemptedSignal;
  assert.equal(
   await Promise.race([
    rosterRevoke.then(() => 'committed'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
   ]),
   'blocked',
   'parent revoke must wait on the roster snapshot lock',
  );
  releaseRosterCreate();
  await rosterCreate;
  await rosterRevoke;
  const racedMembers = await sql.unsafe(
   `select user_id::text from ${quotedSchema}.chat_session_members
     where session_id = $1 order by user_id::text`,
   [raceChildId],
  );
  assert.deepEqual(racedMembers.map((row) => row.user_id), [userId, peerId]);

  // Workspace role evidence is locked by the same transaction that creates a
  // root. A concurrent member removal cannot authorize the write and then
  // commit before it: it waits, the creation commits first, and subsequent
  // creates are denied.
  let releaseRoleCreate;
  const holdRoleCreate = new Promise((resolve) => { releaseRoleCreate = resolve; });
  let rolePrepared;
  const rolePreparedSignal = new Promise((resolve) => { rolePrepared = resolve; });
  const roleCreate = sql.begin(async (transaction) => {
   await transaction.unsafe(`set local search_path to ${quotedSchema}`);
   const db = query(transaction);
   const prepared = await prepareSessionCreateRows({
    db,
    userId,
    rows: [{
     id: lockedRootId,
     workspace_id: workspaceId,
     title: 'Authorized boundary',
    }],
    enforceRead: async () => {},
   });
   const row = prepared.rows[0];
   await db(
    `insert into chat_sessions (id, workspace_id, title)
     values ($1, $2, $3)`,
    [row.id, row.workspace_id, row.title],
   );
   rolePrepared();
   await holdRoleCreate;
  });
  await rolePreparedSignal;
  let roleRevokeAttempted;
  const roleRevokeAttemptedSignal = new Promise((resolve) => { roleRevokeAttempted = resolve; });
  const roleRevoke = sql.begin(async (transaction) => {
   await transaction.unsafe(`set local search_path to ${quotedSchema}`);
   const deletion = transaction.unsafe(
    'delete from workspace_members where workspace_id = $1 and user_id = $2',
    [workspaceId, userId],
   );
   roleRevokeAttempted();
   await deletion;
  });
  await roleRevokeAttemptedSignal;
  assert.equal(
   await Promise.race([
    roleRevoke.then(() => 'committed'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 100)),
   ]),
   'blocked',
   'role revoke must wait on transactional authorization',
  );
  releaseRoleCreate();
  await roleCreate;
  await roleRevoke;
  const lockedRoot = await sql.unsafe(
   `select id from ${quotedSchema}.chat_sessions where id = $1`,
   [lockedRootId],
  );
  assert.equal(lockedRoot.length, 1);
  await assert.rejects(
   sql.begin(async (transaction) => {
    await transaction.unsafe(`set local search_path to ${quotedSchema}`);
    await prepareSessionCreateRows({
     db: query(transaction),
     userId,
     rows: [{
      id: deniedRootId,
      workspace_id: workspaceId,
      title: 'Must be denied',
     }],
     enforceRead: async () => {},
    });
   }),
   (error) => error?.status === 403,
  );
 } finally {
  await sql.unsafe(`drop schema if exists ${quotedSchema} cascade`);
  await sql.end();
 }
});
