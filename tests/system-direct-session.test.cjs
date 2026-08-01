'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');

const WORKSPACE_ID = '20000000-0000-4000-8000-000000000001';
const OWNER_ID = '20000000-0000-4000-8000-000000000002';
const AGENT_ID = '20000000-0000-4000-8000-000000000003';
const SESSION_ID = '20000000-0000-4000-8000-000000000004';
const SESSION_TWO_ID = '20000000-0000-4000-8000-000000000005';
const OTHER_AGENT_ID = '20000000-0000-4000-8000-000000000006';
const OTHER_HUMAN_ID = '20000000-0000-4000-8000-000000000007';

test.afterEach(() => __test.resetTestState());

function directSessionDb({ failMembership = false, workspaceRoles = {} } = {}) {
 const state = {
  sessions: [],
  members: [],
  events: [],
  nextSessionIds: [SESSION_ID, SESSION_TWO_ID],
 };
 let advisoryTail = Promise.resolve();

 const db = {
  state,
  // Post-commit fanout/automation lookups are outside the command transaction.
  // They are deliberately irrelevant to this unit; an empty audience/event set
  // keeps the test focused on the persisted boundary without background noise.
  async unsafe() { return []; },
  async begin(callback) {
   const sessionSnapshot = structuredClone(state.sessions);
   const memberSnapshot = structuredClone(state.members);
   let releaseAdvisory = null;
   const transaction = {
    async unsafe(sql, params = []) {
     const normalized = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
     state.events.push({ sql: normalized, params });
     if (normalized.startsWith('select pg_advisory_xact_lock')) {
      const previous = advisoryTail;
      advisoryTail = new Promise((resolve) => { releaseAdvisory = resolve; });
      await previous;
      return [{ pg_advisory_xact_lock: null }];
     }
     if (normalized.startsWith('select user_id from workspaces')) {
      return [{ user_id: OWNER_ID }];
     }
     if (normalized.startsWith('select id, parent_id, user_id from workspaces')) {
      return [{ id: WORKSPACE_ID, parent_id: null, user_id: OWNER_ID }];
     }
     if (normalized.startsWith('select role from workspace_members')) {
      const role = workspaceRoles[String(params[1])];
      return role ? [{ role }] : [];
     }
     if (normalized.startsWith('select * from chat_sessions')) {
      return state.sessions.map((row) => structuredClone(row));
     }
     if (
      normalized.startsWith('select user_id from chat_session_members')
      || normalized.startsWith('select user_id, source, (user_id = $2::uuid) as requested_user')
     ) {
      return state.members
       .filter((row) => String(row.session_id) === String(params[0]))
       .map((row) => ({ user_id: row.user_id, source: row.source }));
     }
     if (normalized.startsWith('insert into chat_sessions')) {
      const row = {
       id: state.nextSessionIds[state.sessions.length],
       workspace_id: params[0],
       title: params[1],
       model: params[2],
       folder: params[3],
       conversation_mode: params[4],
       participants: JSON.parse(params[5]),
       visibility: params[6],
       created_at: '2026-07-31T12:00:00.000Z',
       deleted_at: null,
      };
      state.sessions.push(row);
      return [structuredClone(row)];
     }
     if (normalized.startsWith('insert into chat_session_members')) {
      if (failMembership) throw new Error('forced member failure');
      const key = `${params[0]}:${params[1]}`;
      if (!state.members.some((row) => `${row.session_id}:${row.user_id}` === key)) {
       state.members.push({
        session_id: params[0],
        user_id: params[1],
        source: 'participant',
       });
      }
      return [];
     }
     throw new Error(`Unexpected SQL in direct-session test: ${sql}`);
    },
   };
   state.events.push({ sql: 'begin', params: [] });
   try {
    const result = await callback(transaction);
    state.events.push({ sql: 'commit', params: [] });
    return result;
   } catch (error) {
    state.sessions.splice(0, state.sessions.length, ...sessionSnapshot);
    state.members.splice(0, state.members.length, ...memberSnapshot);
    state.events.push({ sql: 'rollback', params: [] });
    throw error;
   } finally {
    if (releaseAdvisory) releaseAdvisory();
   }
  },
 };
 return db;
}

test('concurrent system dispatches create one owner-member DM under one transaction key', async () => {
 const db = directSessionDb();
 __test.setTestDb(db);
 const agent = { id: AGENT_ID, name: 'Coder', handle: 'coder', model: 'auto' };

 const [first, second] = await Promise.all([
  __test.findOrCreateDirectSession(WORKSPACE_ID, agent),
  __test.findOrCreateDirectSession(WORKSPACE_ID, agent),
 ]);

 assert.equal(first.id, SESSION_ID);
 assert.equal(second.id, SESSION_ID);
 assert.equal(db.state.sessions.length, 1);
 assert.equal(db.state.members.length, 1);
 assert.deepEqual(db.state.members[0], {
  session_id: SESSION_ID,
  user_id: OWNER_ID,
  source: 'participant',
 });
 assert.equal(
  db.state.events.filter(({ sql }) => sql.startsWith('select pg_advisory_xact_lock')).length,
  2,
 );
 assert.equal(
  db.state.events.filter(({ sql }) => sql.startsWith('insert into chat_sessions')).length,
  1,
 );
});

test('a system DM member failure rolls back the private session', async () => {
 const db = directSessionDb({ failMembership: true });
 __test.setTestDb(db);

 await assert.rejects(
  __test.findOrCreateDirectSession(WORKSPACE_ID, {
   id: AGENT_ID,
   name: 'Coder',
   handle: 'coder',
   model: 'auto',
  }),
  /forced member failure/,
 );

 assert.equal(db.state.sessions.length, 0);
 assert.equal(db.state.members.length, 0);
 assert.equal(db.state.events.some(({ sql }) => sql === 'rollback'), true);
  assert.equal(db.state.events.some(({ sql }) => sql === 'commit'), false);
});

test('non-unique handles never merge two authoritative agent ids into one DM', async () => {
 const db = directSessionDb();
 __test.setTestDb(db);

 const first = await __test.findOrCreateDirectSession(WORKSPACE_ID, {
  id: AGENT_ID,
  name: 'Coder A',
  handle: 'coder',
  model: 'auto',
 });
 const second = await __test.findOrCreateDirectSession(WORKSPACE_ID, {
  id: OTHER_AGENT_ID,
  name: 'Coder B',
  handle: 'coder',
  model: 'auto',
 });

 assert.equal(first.id, SESSION_ID);
 assert.equal(second.id, SESSION_TWO_ID);
 assert.equal(db.state.sessions.length, 2);
 assert.deepEqual(
  db.state.sessions.map((row) => row.participants[0].agent_id),
 [AGENT_ID, OTHER_AGENT_ID],
 );
});

test('an agent rename reuses its existing DM by authoritative id', async () => {
 const db = directSessionDb();
 __test.setTestDb(db);

 const original = await __test.findOrCreateDirectSession(WORKSPACE_ID, {
  id: AGENT_ID,
  name: 'Coder',
  handle: 'coder-old',
  model: 'auto',
 });
 const renamed = await __test.findOrCreateDirectSession(WORKSPACE_ID, {
  id: AGENT_ID,
  name: 'Builder',
  handle: 'builder-new',
  model: 'auto',
 });

 assert.equal(original.id, SESSION_ID);
 assert.equal(renamed.id, SESSION_ID);
 assert.equal(db.state.sessions.length, 1, 'a mutable handle cannot fork one agent into two DMs');
});

test('a legacy participant without agent_id falls back to its matching handle', async () => {
 const db = directSessionDb();
 db.state.sessions.push({
  id: SESSION_ID,
  workspace_id: WORKSPACE_ID,
  title: 'Coder',
  model: 'auto',
  folder: 'Direct messages',
  conversation_mode: 'direct',
  participants: [{ kind: 'agent', handle: 'coder', direct: true }],
  visibility: 'private',
  created_at: '2026-07-30T12:00:00.000Z',
  deleted_at: null,
 });
 db.state.members.push({
  session_id: SESSION_ID,
  user_id: OWNER_ID,
  source: 'participant',
 });
 __test.setTestDb(db);

 const reused = await __test.findOrCreateDirectSession(WORKSPACE_ID, {
  id: AGENT_ID,
  name: 'Coder',
  handle: 'coder',
  model: 'auto',
 });

 assert.equal(reused.id, SESSION_ID);
 assert.equal(db.state.sessions.length, 1, 'legacy handle fallback must not duplicate a live DM');
});

test('individual humans receive distinct private DMs with the same agent', async () => {
 const db = directSessionDb({
  workspaceRoles: { [OTHER_HUMAN_ID]: 'editor' },
 });
 __test.setTestDb(db);
 const agent = { id: AGENT_ID, name: 'Coder', handle: 'coder', model: 'auto' };

 const ownerSession = await __test.findOrCreateDirectSession(
  WORKSPACE_ID,
  agent,
  OWNER_ID,
 );
 const teammateSession = await __test.findOrCreateDirectSession(
  WORKSPACE_ID,
  agent,
  OTHER_HUMAN_ID,
 );
 const teammateAgain = await __test.findOrCreateDirectSession(
  WORKSPACE_ID,
  agent,
  OTHER_HUMAN_ID,
 );

 assert.equal(ownerSession.id, SESSION_ID);
 assert.equal(teammateSession.id, SESSION_TWO_ID);
 assert.equal(teammateAgain.id, SESSION_TWO_ID);
 assert.deepEqual(
  db.state.members.map(({ session_id, user_id }) => ({ session_id, user_id })),
  [
   { session_id: SESSION_ID, user_id: OWNER_ID },
   { session_id: SESSION_TWO_ID, user_id: OTHER_HUMAN_ID },
  ],
 );
});

test('a grant never turns another human’s agent DM into the grantee’s DM', async () => {
 const db = directSessionDb({
  workspaceRoles: { [OTHER_HUMAN_ID]: 'editor' },
 });
 __test.setTestDb(db);
 const agent = { id: AGENT_ID, name: 'Coder', handle: 'coder', model: 'auto' };

 const ownerSession = await __test.findOrCreateDirectSession(
  WORKSPACE_ID,
  agent,
  OWNER_ID,
 );
 db.state.members.push({
  session_id: ownerSession.id,
  user_id: OTHER_HUMAN_ID,
  source: 'grant',
 });

 const granteeSession = await __test.findOrCreateDirectSession(
  WORKSPACE_ID,
  agent,
  OTHER_HUMAN_ID,
 );

 assert.notEqual(granteeSession.id, ownerSession.id);
 assert.equal(granteeSession.id, SESSION_TWO_ID);
 assert.deepEqual(
  db.state.members.filter((row) => row.user_id === OTHER_HUMAN_ID),
  [
   { session_id: SESSION_ID, user_id: OTHER_HUMAN_ID, source: 'grant' },
   { session_id: SESSION_TWO_ID, user_id: OTHER_HUMAN_ID, source: 'participant' },
  ],
 );
});
