'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { issueAuthToken } = require('../shared/backend-core.cjs');

const AUTH_SECRET = 'netlify-lineage-transaction-test-secret';
const USER_ID = '30000000-0000-4000-8000-000000000001';
const WORKSPACE_ID = '30000000-0000-4000-8000-000000000002';
const SESSION_ID = '30000000-0000-4000-8000-000000000003';

let handler;
let failMembership = false;
let clientSequence = 0;
const calls = [];
const clients = [];

function normalized(text) {
 return String(text).replace(/\s+/g, ' ').trim().toLowerCase();
}

function createdSessionRow() {
 return {
  id: SESSION_ID,
  workspace_id: WORKSPACE_ID,
  title: 'Private room',
  model: 'auto',
  folder: 'Direct messages',
  description: '',
  icon: '',
  intent: '',
  is_favorite: false,
  participants: [],
  conversation_mode: 'auto',
  max_agent_turns: 10,
  auto_rounds: 3,
  parent_message_id: null,
  split_parent_id: null,
  split_at: null,
  archived_at: null,
  deleted_at: null,
  canvas_id: null,
  version: 1,
  visibility: 'private',
  created_at: '2026-07-31T12:00:00.000Z',
  updated_at: '2026-07-31T12:00:00.000Z',
 };
}

test.before(async () => {
 process.env.AUTH_SECRET = AUTH_SECRET;
 delete process.env.AGENSIS_AUTH_SECRET;

 const pool = {
  async query(text, params = []) {
   const n = normalized(text);
   calls.push({ lane: 'pool', clientId: null, sql: n, params });
   if (n.startsWith('select token_version from app_users')) {
    return { rows: [{ token_version: '1' }] };
   }
   if (n.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
    return {
     rows: String(params[0]) === WORKSPACE_ID && String(params[1]) === USER_ID
      ? [{ ok: 1 }]
      : [],
    };
   }
   if (n.startsWith('select role from workspace_members')) return { rows: [] };
   if (n.includes('with recursive chain as')) return { rows: [] };
   throw new Error(`Unexpected pool query in Netlify lineage test: ${text}`);
  },
  async connect() {
   const clientId = ++clientSequence;
   const client = {
    clientId,
    released: false,
    async query(text, params = []) {
     const n = normalized(text);
     calls.push({ lane: 'client', clientId, sql: n, params });
     if (n === 'begin' || n === 'commit' || n === 'rollback') return { rows: [] };
     if (n.startsWith('select id, parent_id, user_id from workspaces')) {
      return {
       rows: String(params[0]) === WORKSPACE_ID
        ? [{ id: WORKSPACE_ID, parent_id: null, user_id: USER_ID }]
        : [],
      };
     }
     if (n.startsWith('select role from workspace_members')) return { rows: [] };
     if (n.startsWith('insert into chat_sessions') || n.startsWith('insert into "chat_sessions"')) {
      return { rows: [createdSessionRow()] };
     }
     if (n.startsWith('insert into chat_session_members')) {
      if (failMembership) throw new Error('forced Netlify membership failure');
      return { rows: [] };
     }
     throw new Error(`Unexpected transaction query in Netlify lineage test: ${text}`);
    },
    release() {
     this.released = true;
    },
   };
   clients.push(client);
   return client;
  },
 };

 mock.module('@netlify/database', {
  namedExports: {
   getDatabase: () => ({ pool }),
  },
 });
 mock.module('@netlify/identity', {
  namedExports: { getUser: async () => null },
 });

 const moduleUrl = pathToFileURL(
  path.resolve(__dirname, '../netlify/functions/backend.mjs'),
 ).href;
 handler = (await import(`${moduleUrl}?session-lineage-netlify`)).default;
});

function insertRequest() {
 const token = issueAuthToken(USER_ID, '1', AUTH_SECRET);
 return new Request('https://app.test/backend/db/insert', {
  method: 'POST',
  headers: {
   Authorization: `Bearer ${token}`,
   'Content-Type': 'application/json',
  },
  body: JSON.stringify({
   table: 'chat_sessions',
   values: {
    workspace_id: WORKSPACE_ID,
    title: 'Private room',
    folder: 'Direct messages',
    visibility: 'workspace',
   },
   returning: 'id,title,folder,visibility',
   single: true,
  }),
 });
}

test.beforeEach(() => {
 calls.length = 0;
 clients.length = 0;
 failMembership = false;
});

test('Netlify creates the private session and member graph on one PoolClient', async () => {
 const response = await handler(insertRequest());
 assert.equal(response.status, 200);
 const body = await response.json();
 assert.deepEqual(body.data, {
  id: SESSION_ID,
  title: 'Private room',
  folder: 'Direct messages',
  visibility: 'private',
 });

 assert.equal(clients.length, 1);
 assert.equal(clients[0].released, true);
 const transactionCalls = calls.filter(({ lane }) => lane === 'client');
 assert.equal(new Set(transactionCalls.map(({ clientId }) => clientId)).size, 1);
 assert.deepEqual(
  transactionCalls.map(({ sql }) => {
   if (sql.startsWith('select id, parent_id, user_id from workspaces')) return 'LOCK_WORKSPACE';
   if (sql.startsWith('select role from workspace_members')) return 'LOCK_ROLE';
   if (sql.startsWith('insert into chat_sessions') || sql.startsWith('insert into "chat_sessions"')) return 'INSERT_SESSION';
   if (sql.startsWith('insert into chat_session_members')) return 'INSERT_MEMBER';
   return sql.toUpperCase();
  }),
  ['BEGIN', 'LOCK_WORKSPACE', 'LOCK_ROLE', 'INSERT_SESSION', 'INSERT_MEMBER', 'COMMIT'],
 );
});

test('Netlify membership failure rolls back and returns no created session', async () => {
 failMembership = true;
 const response = await handler(insertRequest());
 assert.equal(response.status, 500);
 const body = await response.json();
 assert.equal(body.data, null);
 assert.match(body.error.message, /forced Netlify membership failure/);

 assert.equal(clients.length, 1);
 assert.equal(clients[0].released, true);
 const transactionCalls = calls.filter(({ lane }) => lane === 'client');
 assert.equal(
  transactionCalls.some(({ sql }) => (
   sql.startsWith('insert into chat_sessions') || sql.startsWith('insert into "chat_sessions"')
  )),
  true,
 );
 assert.equal(
  transactionCalls.some(({ sql }) => sql.startsWith('insert into chat_session_members')),
  true,
 );
 assert.equal(transactionCalls.at(-1).sql, 'rollback');
 assert.equal(transactionCalls.some(({ sql }) => sql === 'commit'), false);
});
