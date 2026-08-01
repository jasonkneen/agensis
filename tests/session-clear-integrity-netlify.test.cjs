'use strict';

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const AUTH_SECRET = 'netlify-clear-integrity-secret';
const USER = '11111111-1111-4111-8111-111111111111';
const WORKSPACE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let handler;
let sessionKind = 'private';
let classificationChanged = false;
let sessionExists = true;
let workspaceAuthorized = true;
let sessionReadable = true;
let clearLock = null;
let clearAttempts = [];
let activityScrub = null;
let transactionFrames = [];

test.before(async () => {
  process.env.AUTH_SECRET = AUTH_SECRET;
  delete process.env.AGENSIS_AUTH_SECRET;
  delete process.env.AGENSIS_DAEMON_BASE_URL;
  delete process.env.AGENSIS_WS_BASE_URL;
  delete process.env.NETLIFY;
  delete process.env.CONTEXT;
  delete process.env.DEPLOY_PRIME_URL;
  mock.module('@netlify/database', {
    exports: {
      getDatabase: () => ({
        pool: {
          async query(sql, params = []) {
            const normalized = String(sql).replace(/\s+/g, ' ').trim();
            const q = normalized.toLowerCase();
            if (['begin', 'commit', 'rollback'].includes(q)) {
              transactionFrames.push(q);
              return { rows: [] };
            }
            if (q.startsWith('alter table') || q.startsWith('create table')
              || q.startsWith('create index') || q.startsWith('create unique index')) {
              return { rows: [] };
            }
            if (q.startsWith('select token_version from app_users')) {
              return { rows: [{ token_version: '1' }] };
            }
            if (
              q.startsWith(
                'select id, workspace_id, visibility, folder, parent_message_id, split_parent_id, deleted_at from chat_sessions',
              )
            ) {
              return {
                rows: sessionExists ? [{
                  id: SESSION,
                  workspace_id: WORKSPACE,
                  visibility: sessionKind === 'private' ? 'private' : 'workspace',
                  folder: sessionKind === 'private' ? 'Direct messages' : 'Channels',
                  parent_message_id: null,
                  split_parent_id: null,
                  deleted_at: null,
                }] : [],
              };
            }
            if (q.startsWith('select 1 from workspaces where id = $1 and user_id = $2')) {
              return { rows: workspaceAuthorized ? [{ ok: 1 }] : [] };
            }
            if (q.startsWith('select role from workspace_members')) {
              return { rows: [] };
            }
            if (q.startsWith('with recursive chain as')) {
              return { rows: [] };
            }
            if (q.startsWith('select 1 from chat_session_members')) {
              return { rows: sessionReadable ? [{ ok: 1 }] : [] };
            }
            if (q.includes('select clear_session_scope.id')) {
              clearLock = { sql: normalized, params };
              return { rows: classificationChanged ? [] : [{ id: SESSION }] };
            }
            if (q.startsWith('select huddle.id, huddle.workspace_id')) {
              return { rows: [] };
            }
            if (q.startsWith('select child_session.id')) {
              return { rows: [] };
            }
            if (q.startsWith('update agent_schedules')) {
              clearAttempts.push({ sql: normalized, params });
              return { rows: [] };
            }
            if (q.startsWith('update agent_jobs')) {
              clearAttempts.push({ sql: normalized, params });
              return {
                rows: Array.from({ length: 4 }, (_, index) => ({
                  id: `${index + 1}0000000-0000-4000-8000-000000000000`,
                  workspace_id: WORKSPACE,
                  session_id: SESSION,
                  agent_id: '99999999-9999-4999-8999-999999999999',
                  connection_id: null,
                  status: 'cancelled',
                  metadata: { stopReason: 'cancelled' },
                })),
              };
            }
            if (q.startsWith('update agent_permission_requests')) {
              clearAttempts.push({ sql: normalized, params });
              return { rows: [] };
            }
            if (q.startsWith('with cleared_messages')) {
              clearAttempts.push({ sql: normalized, params });
              return { rows: [{ cleared_messages: 23 }] };
            }
            if (q.startsWith('update chat_sessions')) {
              clearAttempts.push({ sql: normalized, params });
              return {
                rows: [{
                  id: SESSION,
                  workspace_id: WORKSPACE,
                  visibility: 'private',
                  folder: 'Direct messages',
                  deleted_at: '2026-07-31T12:00:00.000Z',
                }],
              };
            }
            if (q.startsWith('with scrubbed_activity')) {
              activityScrub = { sql: normalized, params };
              return { rows: [{ scrubbed_activity: 23 }] };
            }
            throw new Error(`Unexpected Netlify clear query: ${normalized}`);
          },
          async connect() {
            return {
              query: (sql, params = []) => this.query(sql, params),
              release() {},
            };
          },
        },
      }),
    },
  });
  const backend = await import(
    pathToFileURL(path.resolve(__dirname, '../netlify/functions/backend.mjs')).href
  );
  handler = backend.default;
});

function token() {
  const payload = `${USER}.1.${Math.floor(Date.now() / 1000)}`;
  const signature = crypto.createHmac('sha256', AUTH_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

async function clearSession() {
  return handler(new Request(`http://localhost/backend/sessions/${SESSION}/clear`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}` },
  }));
}

test.beforeEach(() => {
  sessionKind = 'private';
  classificationChanged = false;
  sessionExists = true;
  workspaceAuthorized = true;
  sessionReadable = true;
  clearLock = null;
  clearAttempts = [];
  activityScrub = null;
  transactionFrames = [];
});

test('Netlify clear locks the same private classification it authorized and returns counts only', async () => {
  const response = await clearSession();
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(await response.json(), {
    data: {
      sessionId: SESSION,
      clearedMessages: 23,
      cancelledJobs: 4,
      closed: true,
    },
    error: null,
  });
  assert.ok(clearLock);
  assert.equal(clearAttempts.length, 5);
  assert.ok(activityScrub);
  assert.match(clearLock.sql, /visibility is not distinct from \$3/i);
  assert.match(clearLock.sql, /folder is not distinct from \$4/i);
  assert.match(clearLock.sql, /join chat_session_members clear_session_member/i);
  assert.match(clearLock.sql, /with recursive clear_workspace_chain/i);
  assert.match(clearLock.sql, /clear_manager_membership/i);
  assert.match(clearLock.sql, /for share of workspace/i);
  assert.match(clearLock.sql, /for share of membership/i);
  assert.match(clearLock.sql, /for update of clear_session_scope, clear_session_member/i);
  assert.match(clearAttempts[0].sql, /^update agent_schedules/i);
  assert.match(clearAttempts[0].sql, /enabled = false/i);
  assert.match(clearAttempts[1].sql, /^update agent_jobs/i);
  assert.match(clearAttempts[1].sql, /status = 'cancelled'/i);
  assert.match(clearAttempts[1].sql, /error = 'Conversation deleted'/i);
  assert.match(clearAttempts[1].sql, /"stopReason":"cancelled"/i);
  assert.match(clearAttempts[1].sql, /status in \('queued', 'running'\)/i);
  assert.match(clearAttempts[2].sql, /^update agent_permission_requests/i);
  assert.match(clearAttempts[2].sql, /status = 'expired'/i);
  assert.match(clearAttempts[3].sql, /^with cleared_messages/i);
  assert.match(clearAttempts[4].sql, /^update chat_sessions/i);
  for (const attempt of clearAttempts) {
    assert.doesNotMatch(attempt.sql, /returning \*/i);
    assert.doesNotMatch(attempt.sql, /jsonb_agg/i);
  }
  assert.deepEqual(clearLock.params, [SESSION, USER, 'private', 'Direct messages', WORKSPACE]);
  assert.match(activityScrub.sql, /activity_message\.session_id = any\(\$1::uuid\[\]\)/i);
  assert.match(activityScrub.sql, /metadata = jsonb_build_object/i);
  assert.deepEqual(activityScrub.params, [`{"${SESSION}"}`, 'Message deleted']);
  assert.deepEqual(transactionFrames, ['begin', 'commit']);
});

test('Netlify clear fails closed when the classification changes before its locked write', async () => {
  classificationChanged = true;
  const response = await clearSession();
  assert.equal(response.status, 403, await response.clone().text());
  assert.match((await response.json()).error.message, /access changed/i);
  assert.ok(clearLock);
  assert.deepEqual(clearAttempts, []);
  assert.deepEqual(transactionFrames, ['begin', 'rollback']);
});

test('Netlify clear rejects a public channel before issuing the clear statement', async () => {
  sessionKind = 'public';
  const response = await clearSession();
  assert.equal(response.status, 400, await response.clone().text());
  assert.equal(clearLock, null);
  assert.deepEqual(clearAttempts, []);
  assert.deepEqual(transactionFrames, []);
});

test('Netlify clear conceals unknown and unauthorized classifications behind one response', async () => {
  const attempts = [];

  sessionExists = false;
  attempts.push(await clearSession());

  sessionExists = true;
  workspaceAuthorized = false;
  sessionKind = 'public';
  attempts.push(await clearSession());

  sessionKind = 'private';
  attempts.push(await clearSession());

  workspaceAuthorized = true;
  sessionReadable = false;
  attempts.push(await clearSession());

  for (const response of attempts) {
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      data: null,
      error: { message: 'Conversation not found or unavailable', code: null },
    });
  }
  assert.equal(clearLock, null);
  assert.deepEqual(clearAttempts, []);
  assert.deepEqual(transactionFrames, []);
});
