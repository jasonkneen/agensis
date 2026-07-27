// ============================================================================
// tests/tenants-admin.test.cjs
// ----------------------------------------------------------------------------
// The owner-only Tenants surface — /backend/tenants{,/access,/:id}.
//
// This is the one surface in the product that reads ACROSS accounts and
// workspaces: every registered account, and per account the workspaces it owns
// and belongs to. Nothing else here is un-scoped, so the gate is the feature and
// these tests are written the way it has to fail:
//
//   NEGATIVE FIRST. An unauthenticated caller, an ordinary authenticated user,
//   a user whose email merely RESEMBLES the owner's, and — the one a hand-rolled
//   check always gets wrong — a caller who supplies the owner's address in the
//   request body or a header while holding somebody else's session. Only then
//   the owner, so that "the owner succeeds" cannot be the only thing asserted
//   (a gate stuck open passes that one too).
//
// The route tests run the REAL netlify/functions/backend.mjs handler against a
// mocked Postgres, so what is asserted is the wiring — requireUserId, the
// limiter, then assertSystemOwner — not a re-implementation of it. server/
// index.cjs cannot be booted here (WebSocket server + live DB), so its half is
// pinned by (a) sharing ONE gate function with the Netlify side, tested directly
// below, and (b) source assertions that each of its three routes is wrapped in
// requireAuth, rate-limited, and calls that gate.
//
// The pure predicate — (callerEmail, configuredOwnerEmail) -> boolean, with its
// case/whitespace/unset/near-miss cases — is unit tested in
// tests/unit/tenantOwnerCheck.test.ts.
// ============================================================================

const test = require('node:test');
const { mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const root = path.resolve(__dirname, '..');
const core = require('../shared/backend-core.cjs');
const tenantAdmin = require('../shared/tenant-admin.cjs');

const serverSource = fs.readFileSync(path.join(root, 'server/index.cjs'), 'utf8');
const netlifySource = fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8');

const OWNER_EMAIL = 'owner@example.test';
const OWNER_ID = '11111111-1111-4111-8111-111111111111';
const MEMBER_ID = '22222222-2222-4222-8222-222222222222';
const NEAR_MISS_ID = '33333333-3333-4333-8333-333333333333';

const EMAIL_BY_USER = {
 [OWNER_ID]: OWNER_EMAIL,
 [MEMBER_ID]: 'ordinary@example.test',
 // Deliberately close enough to fool a startsWith/includes/LIKE check.
 [NEAR_MISS_ID]: 'owner@example.test.evil.test',
};

// --- Fixtures for the usage/stats half -------------------------------------
// Counts come back from Postgres as bigint STRINGS on both drivers, so they are
// strings here — a shaping bug that only shows up against a real database is
// the exact thing this fixture exists to catch.
const METERING_STARTED_AT = '2026-07-01T00:00:00.000Z';

const WORKSPACE_STATS_ROW = {
 workspace_id: 'ws-1',
 user_id: OWNER_ID,
 channel_count: '4',
 dm_count: '2',
 thread_count: '3',
 message_count: '120',
 agent_message_count: '80',
 human_message_count: '40',
 huddle_count: '2',
 live_huddle_count: '1',
 huddle_seconds: '3600',
 agent_count: '5',
 live_daemon_count: '1',
 document_count: '7',
 member_count: '2',
 last_activity_at: '2026-07-20T00:00:00.000Z',
};

const USAGE_ROWS = [
 {
  workspace_id: 'ws-1',
  provider: 'anthropic',
  resource: 'claude-opus-4-5',
  calls: '10',
  input_units: '1000000',
  output_units: '200000',
  cache_write_units: '0',
  cache_read_units: '0',
  first_at: '2026-07-02T00:00:00.000Z',
  last_at: '2026-07-20T00:00:00.000Z',
 },
 // Metered, but with no rate configured: its spend must NOT land in the total
 // and the response has to name it so the UI can say the figure is short.
 {
  workspace_id: 'ws-1',
  provider: 'deepgram',
  resource: 'flux',
  calls: '4',
  input_units: '600',
  output_units: '0',
  cache_write_units: '0',
  cache_read_units: '0',
  first_at: '2026-07-05T00:00:00.000Z',
  last_at: '2026-07-06T00:00:00.000Z',
 },
];

let handler;      // the real netlify handler
let authSecret;
/** Every SQL string the handler issued, newest last — inspected for leaks. */
let issuedSql = [];

test.before(async () => {
 // Own both names outright. The backend reads `AGENSIS_AUTH_SECRET ||
 // AUTH_SECRET`, the opposite precedence to the `||` this used to sign with, so
 // a machine with both set signed every token here with the wrong key and 401'd
 // the file. The preload scrubs both; this makes the file correct on its own.
 delete process.env.AGENSIS_AUTH_SECRET;
 process.env.AUTH_SECRET = 'tenants-admin-test-secret';
 authSecret = process.env.AUTH_SECRET;
 // The owner address the gate compares against. Set here rather than read from
 // the environment so the tests never depend on the developer's own .env — and
 // so the "unset" case below can clear it deliberately.
 process.env.AGENSIS_SYSTEM_OWNER_EMAIL = OWNER_EMAIL;

 mock.module('@netlify/database', {
  namedExports: {
   getDatabase: () => ({
    pool: {
     async query(text, params) {
      issuedSql.push(String(text));
      const sql = String(text).replace(/\s+/g, ' ').trim().toLowerCase();
      if (sql.startsWith('alter table') || sql.startsWith('create table') || sql.startsWith('create index')) {
       return { rows: [] };
      }
      // Session verification (verifyAuthToken -> getTokenVersion).
      if (/select token_version from app_users/.test(sql)) return { rows: [{ token_version: '1' }] };
      // The cross-instance rate limiter's shared counter.
      if (sql.startsWith('insert into rate_limits')) return { rows: [{ count: 1 }] };
      if (sql.startsWith('delete from rate_limits')) return { rows: [] };
      // THE OWNER LOOKUP. Keyed on the userId from the verified token — there is
      // no path here that takes an email from the request.
      if (/select email from app_users where id = \$1/.test(sql)) {
       const email = EMAIL_BY_USER[params?.[0]];
       return { rows: email ? [{ email }] : [] };
      }
      if (/from app_users u/.test(sql) && /where u\.id = \$1/.test(sql)) {
       if (params?.[0] !== OWNER_ID) return { rows: [] };
       return {
        rows: [{
         id: OWNER_ID,
         email: OWNER_EMAIL,
         display_name: 'The Owner',
         accent_color: '',
         created_at: '2026-01-01T00:00:00.000Z',
         owned_workspace_count: '2',
         membership_count: '0',
        }],
       };
      }
      if (/from app_users u/.test(sql)) {
       return {
        rows: [
         {
          id: OWNER_ID,
          email: OWNER_EMAIL,
          display_name: 'The Owner',
          accent_color: '',
          created_at: '2026-01-01T00:00:00.000Z',
          owned_workspace_count: '2',
          membership_count: '0',
         },
         {
          id: MEMBER_ID,
          email: 'ordinary@example.test',
          display_name: '',
          accent_color: '',
          created_at: '2026-02-01T00:00:00.000Z',
          owned_workspace_count: '1',
          membership_count: '3',
         },
        ],
       };
      }
      if (/count\(\*\) as total from app_users/.test(sql)) return { rows: [{ total: '2' }] };
      if (/from workspaces w where w\.user_id = \$1/.test(sql)) {
       return {
        rows: [{
         id: 'ws-1', name: 'Acme', icon: '', is_system: false, parent_id: null,
         created_at: '2026-01-02T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
         member_count: '2', agent_count: '1',
        }],
       };
      }
      if (/from workspace_members m join workspaces w/.test(sql)) return { rows: [] };
      // The batched per-workspace activity aggregate (WORKSPACE_STATS_SQL). ONE
      // query for the whole list — the detail route runs the same SQL with a
      // `where ws.user_id = $1` appended, which is why both land here.
      if (/^with ws as \(/.test(sql)) {
       const scoped = /where ws\.user_id = \$1/.test(sql);
       if (scoped && params?.[0] !== OWNER_ID) return { rows: [] };
       return { rows: [WORKSPACE_STATS_ROW] };
      }
      // The usage ledger, grouped per workspace and per (provider, resource).
      if (/from usage_events/.test(sql) && /group by/.test(sql)) {
       const scoped = /join workspaces w/.test(sql);
       if (scoped && params?.[0] !== OWNER_ID) return { rows: [] };
       return { rows: USAGE_ROWS };
      }
      // The metering window: when metering started, and what it has seen.
      if (/usage\.metering_started_at/.test(sql)) {
       return {
        rows: [{
         configured_start: METERING_STARTED_AT,
         first_event_at: '2026-07-02T00:00:00.000Z',
         last_event_at: '2026-07-20T00:00:00.000Z',
        }],
       };
      }
      throw new Error(`Unexpected DB query in tenants-admin test: ${sql}`);
     },
    },
   }),
  },
 });

 handler = (await import(pathToFileURL(path.join(root, 'netlify/functions/backend.mjs')).href)).default;
});

function tokenFor(userId) {
 return core.issueAuthToken(userId, 1, authSecret);
}

function request(method, pathname, { token, body, headers = {} } = {}) {
 const init = { method, headers: { ...headers } };
 if (token !== undefined) init.headers.Authorization = `Bearer ${token}`;
 if (body !== undefined) {
  init.headers['Content-Type'] = 'application/json';
  init.body = JSON.stringify(body);
 }
 return new Request(`http://localhost${pathname}`, init);
}

async function call(method, pathname, options) {
 issuedSql = [];
 const res = await handler(request(method, pathname, options));
 return { res, body: await res.json().catch(() => null) };
}

const TENANT_ROUTES = [
 ['GET', '/backend/tenants'],
 [`GET`, `/backend/tenants/${OWNER_ID}`],
];

// ---------------------------------------------------------------------------
// 1. Unauthenticated
// ---------------------------------------------------------------------------

for (const [method, pathname] of [...TENANT_ROUTES, ['GET', '/backend/tenants/access']]) {
 test(`${method} ${pathname} refuses a caller with no Authorization header`, async () => {
  const { res } = await call(method, pathname);
  assert.equal(res.status, 401);
  // Nothing was read before the refusal beyond schema bootstrap.
  assert.equal(issuedSql.some((sql) => /from app_users u/.test(sql)), false);
 });

 test(`${method} ${pathname} refuses a garbage bearer token`, async () => {
  const { res } = await call(method, pathname, { token: 'not-a-real-token' });
  assert.equal(res.status, 401);
 });

 test(`${method} ${pathname} refuses a token whose signature does not verify`, async () => {
  // Correctly SHAPED (userId.version.issuedAt.sig) but signed with another key —
  // the shape is the part an attacker can copy from a real token.
  const forged = `${OWNER_ID}.1.${Math.floor(Date.now() / 1000)}.deadbeef`;
  const { res } = await call(method, pathname, { token: forged });
  assert.equal(res.status, 401);
 });
}

// ---------------------------------------------------------------------------
// 2. Authenticated, but not the owner — the case the whole feature turns on
// ---------------------------------------------------------------------------

for (const [method, pathname] of TENANT_ROUTES) {
 test(`${method} ${pathname} refuses an ORDINARY authenticated user with a valid token`, async () => {
  const { res, body } = await call(method, pathname, { token: tokenFor(MEMBER_ID) });
  assert.equal(res.status, 403);
  assert.equal(body.data, null);
  // Refused BEFORE any tenant data was read. A 403 assembled after the query
  // has already run is one bad `return` away from being a 200.
  assert.equal(issuedSql.some((sql) => /from app_users u/.test(sql)), false);
  assert.equal(issuedSql.some((sql) => /from workspaces w/.test(sql)), false);
 });

 test(`${method} ${pathname} refuses an email that RESEMBLES the owner's`, async () => {
  // owner@example.test.evil.test — passes startsWith, passes includes, passes a
  // LIKE 'owner@example.test%'. Exact equality is what refuses it.
  const { res } = await call(method, pathname, { token: tokenFor(NEAR_MISS_ID) });
  assert.equal(res.status, 403);
 });

 test(`${method} ${pathname} refuses a non-owner who SUPPLIES the owner's email`, async () => {
  // The attack a hand-rolled check invites: hold your own valid session and name
  // the owner in every channel a GET has — query string and headers. The gate
  // reads none of them; the email comes from app_users, keyed by the userId the
  // token was signed for. (These routes are GET-only, so a request body is not
  // even expressible — the "READ-ONLY, no write route" test below pins that.)
  const attempts = [
   { headers: { 'x-user-email': OWNER_EMAIL, 'x-agensis-owner': OWNER_EMAIL } },
   { headers: { 'x-forwarded-user': OWNER_EMAIL, 'x-agensis-user-id': OWNER_ID } },
  ];
  for (const attempt of attempts) {
   const { res } = await call(method, `${pathname}?email=${encodeURIComponent(OWNER_EMAIL)}&userId=${OWNER_ID}`, {
    token: tokenFor(MEMBER_ID),
    ...attempt,
   });
   assert.equal(res.status, 403);
  }
  // And the owner lookup only ever bound the caller's own id.
  assert.equal(issuedSql.some((sql) => /select email from app_users where id = \$1/i.test(sql)), true);
 });

 test(`${method} ${pathname} refuses a token for a user id that no longer exists`, async () => {
  const { res } = await call(method, pathname, { token: tokenFor('44444444-4444-4444-8444-444444444444') });
  assert.equal(res.status, 403);
 });
}

test('GET /backend/tenants/access reports owner:false for an ordinary user (and does not 403)', async () => {
 // It answers about the CALLER only, so it is safe for anyone signed in — the
 // client uses it to decide whether to render the button at all, and a 403 here
 // would be a console error in every ordinary session.
 const { res, body } = await call('GET', '/backend/tenants/access', { token: tokenFor(MEMBER_ID) });
 assert.equal(res.status, 200);
 assert.deepEqual(body.data, { owner: false });
});

test('a non-owner cannot reach ANOTHER account by id', async () => {
 const { res } = await call('GET', `/backend/tenants/${MEMBER_ID}`, { token: tokenFor(MEMBER_ID) });
 // Not even their own row: this surface is not "read yourself", it is admin.
 assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// 3. Fail closed when nothing is configured
// ---------------------------------------------------------------------------

test('with AGENSIS_SYSTEM_OWNER_EMAIL unset, EVERY caller is refused — including the owner', async () => {
 const previous = process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
 try {
  delete process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
  for (const [method, pathname] of TENANT_ROUTES) {
   const { res } = await call(method, pathname, { token: tokenFor(OWNER_ID) });
   assert.equal(res.status, 403, `${method} ${pathname} must refuse when no owner is configured`);
  }
  const { body } = await call('GET', '/backend/tenants/access', { token: tokenFor(OWNER_ID) });
  assert.deepEqual(body.data, { owner: false });
 } finally {
  process.env.AGENSIS_SYSTEM_OWNER_EMAIL = previous;
 }
});

test('a blank/whitespace-only AGENSIS_SYSTEM_OWNER_EMAIL is the same as unset', async () => {
 const previous = process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
 try {
  process.env.AGENSIS_SYSTEM_OWNER_EMAIL = '   ';
  const { res } = await call('GET', '/backend/tenants', { token: tokenFor(OWNER_ID) });
  assert.equal(res.status, 403);
 } finally {
  process.env.AGENSIS_SYSTEM_OWNER_EMAIL = previous;
 }
});

// ---------------------------------------------------------------------------
// 4. The owner — and what the response is allowed to contain
// ---------------------------------------------------------------------------

test('the owner gets the account list', async () => {
 const { res, body } = await call('GET', '/backend/tenants', { token: tokenFor(OWNER_ID) });
 assert.equal(res.status, 200);
 assert.equal(body.error, null);
 assert.equal(body.data.accounts.length, 2);
 assert.equal(body.data.total, 2);
 assert.equal(body.data.truncated, false);
 // bigint counts arrive as strings on both drivers; the shared shaping coerces.
 assert.equal(body.data.accounts[0].owned_workspace_count, 2);
 assert.equal(body.data.accounts[1].membership_count, 3);
});

test('the owner gets one account with its workspaces', async () => {
 const { res, body } = await call('GET', `/backend/tenants/${OWNER_ID}`, { token: tokenFor(OWNER_ID) });
 assert.equal(res.status, 200);
 assert.equal(body.data.account.email, OWNER_EMAIL);
 assert.equal(body.data.owned_workspaces.length, 1);
 assert.equal(body.data.owned_workspaces[0].member_count, 2);
 assert.deepEqual(body.data.member_workspaces, []);
});

test('an unknown account id is 404, not an empty 200 that reads like a permissions bug', async () => {
 const { res } = await call('GET', '/backend/tenants/99999999-9999-4999-8999-999999999999', {
  token: tokenFor(OWNER_ID),
 });
 assert.equal(res.status, 404);
});

test('GET /backend/tenants/access reports owner:true for the owner', async () => {
 const { body } = await call('GET', '/backend/tenants/access', { token: tokenFor(OWNER_ID) });
 assert.deepEqual(body.data, { owner: true });
});

test('the owner is case-insensitively matched, so a differently-cased stored email still works', async () => {
 const previous = process.env.AGENSIS_SYSTEM_OWNER_EMAIL;
 try {
  process.env.AGENSIS_SYSTEM_OWNER_EMAIL = ` ${OWNER_EMAIL.toUpperCase()}\n`;
  const { res } = await call('GET', '/backend/tenants', { token: tokenFor(OWNER_ID) });
  assert.equal(res.status, 200);
 } finally {
  process.env.AGENSIS_SYSTEM_OWNER_EMAIL = previous;
 }
});

test('no tenant response carries a password hash, a token version or any secret', async () => {
 const responses = [
  await call('GET', '/backend/tenants', { token: tokenFor(OWNER_ID) }),
  await call('GET', `/backend/tenants/${OWNER_ID}`, { token: tokenFor(OWNER_ID) }),
 ];
 for (const { body } of responses) {
  const serialized = JSON.stringify(body);
  for (const forbiddenKey of [
   'password_hash', 'token_version', 'mcp_token_hash', 'connect_token_hash',
   'api_key_cipher', 'access_token', 'local_path', 'git_remote',
  ]) {
   assert.equal(
    serialized.includes(forbiddenKey), false,
    `a tenant response must never carry ${forbiddenKey}`,
   );
  }
 }
});

test('the SQL the tenant routes issue never selects * or a privileged column from app_users', async () => {
 await call('GET', '/backend/tenants', { token: tokenFor(OWNER_ID) });
 const appUserSelects = issuedSql.filter((sql) => /from app_users/i.test(sql));
 assert.ok(appUserSelects.length > 0, 'expected the list route to read app_users');
 for (const sql of appUserSelects) {
  assert.equal(/select\s+\*/i.test(sql), false, `select * from app_users leaks the password hash:\n${sql}`);
  assert.equal(/password_hash/i.test(sql), false);
  assert.equal(/token_version/i.test(sql), false);
 }
});

// ---------------------------------------------------------------------------
// 5. The gate itself, called directly — one function, both backends
// ---------------------------------------------------------------------------

function ownerDb(emailByUser = EMAIL_BY_USER) {
 return async function db(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').toLowerCase();
  if (text.includes('select email from app_users where id = $1')) {
   const email = emailByUser[params[0]];
   return email ? [{ email }] : [];
  }
  throw new Error(`Unexpected SQL: ${text}`);
 };
}

const OWNER_ENV = { AGENSIS_SYSTEM_OWNER_EMAIL: OWNER_EMAIL };

test('assertSystemOwner throws 401 without an authenticated userId', async () => {
 for (const userId of [null, undefined, '', '   ']) {
  await assert.rejects(
   () => tenantAdmin.assertSystemOwner({ userId, db: ownerDb(), env: OWNER_ENV }),
   (error) => error.status === 401,
  );
 }
});

test('assertSystemOwner throws 403 for a non-owner, a near miss, and a missing user row', async () => {
 for (const userId of [MEMBER_ID, NEAR_MISS_ID, 'no-such-user']) {
  await assert.rejects(
   () => tenantAdmin.assertSystemOwner({ userId, db: ownerDb(), env: OWNER_ENV }),
   (error) => error.status === 403,
   `${userId} must be refused`,
  );
 }
});

test('assertSystemOwner throws 403 when no owner is configured, whoever is asking', async () => {
 for (const env of [{}, { AGENSIS_SYSTEM_OWNER_EMAIL: '' }, { AGENSIS_SYSTEM_OWNER_EMAIL: '  ' }]) {
  await assert.rejects(
   () => tenantAdmin.assertSystemOwner({ userId: OWNER_ID, db: ownerDb(), env }),
   (error) => error.status === 403,
  );
 }
});

test('assertSystemOwner never reads an email from anything but the DB row for that userId', async () => {
 const bound = [];
 const db = async (sql, params = []) => {
  bound.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params });
  return [{ email: EMAIL_BY_USER[params[0]] || '' }];
 };
 // Extra fields on the argument object — the shape a careless refactor would
 // start trusting — must be ignored entirely.
 await assert.rejects(
  () => tenantAdmin.assertSystemOwner({
   userId: MEMBER_ID, db, env: OWNER_ENV,
   email: OWNER_EMAIL, callerEmail: OWNER_EMAIL, ownerEmail: OWNER_EMAIL,
  }),
  (error) => error.status === 403,
 );
 assert.equal(bound.length, 1);
 assert.deepEqual(bound[0].params, [MEMBER_ID]);
 assert.equal(bound[0].sql.includes('$1'), true);
 // The owner address is never interpolated into the SQL.
 assert.equal(bound[0].sql.includes(OWNER_EMAIL), false);
});

test('assertSystemOwner resolves for the owner and returns the caller id', async () => {
 assert.equal(
  await tenantAdmin.assertSystemOwner({ userId: OWNER_ID, db: ownerDb(), env: OWNER_ENV }),
  OWNER_ID,
 );
 // Whitespace around the token-derived id is tolerated; a different id is not.
 assert.equal(
  await tenantAdmin.assertSystemOwner({ userId: ` ${OWNER_ID} `, db: ownerDb(), env: OWNER_ENV }),
  OWNER_ID,
 );
});

test('a DB error during the owner lookup refuses rather than granting', async () => {
 const db = async () => { throw new Error('connection reset'); };
 await assert.rejects(
  () => tenantAdmin.assertSystemOwner({ userId: OWNER_ID, db, env: OWNER_ENV }),
  (error) => error.message === 'connection reset',
 );
 // The route's catch maps a thrown error to a 500 — a refusal, not a 200.
});

test('the projection is sourced from the shared app_users allow-list', async () => {
 const columns = tenantAdmin.tenantUserColumns('u');
 assert.equal(columns, 'u.id, u.email, u.display_name, u.accent_color, u.created_at');
 // Belt and braces: whatever SELECTABLE_COLUMNS_BY_TABLE holds, these two are
 // not in it, and the tenant projection is derived from that same list.
 assert.equal(core.SELECTABLE_COLUMNS_BY_TABLE.app_users.includes('password_hash'), false);
 assert.equal(core.SELECTABLE_COLUMNS_BY_TABLE.app_users.includes('token_version'), false);
});

test('getTenantAccount rejects a blank account id with 400 instead of scanning', async () => {
 const db = async () => { throw new Error('should not be called'); };
 await assert.rejects(
  () => tenantAdmin.getTenantAccount(db, '   '),
  (error) => error.status === 400,
 );
});

test('listTenantAccounts caps its limit and reports the true total', async () => {
 const bound = [];
 const db = async (sql, params = []) => {
  bound.push(params);
  if (/count\(\*\) as total/i.test(String(sql))) return [{ total: '4212' }];
  return [{ id: 'a', email: 'a@x.test', owned_workspace_count: '0', membership_count: '0' }];
 };
 const result = await tenantAdmin.listTenantAccounts(db, { limit: 10_000 });
 assert.equal(bound[0][0], tenantAdmin.TENANT_LIST_LIMIT);
 assert.equal(result.total, 4212);
 assert.equal(result.truncated, true, 'a capped list must say so rather than under-report');
});

// ---------------------------------------------------------------------------
// 5b. Statistics and cost, on the SAME owner gate
//
// These are new projections over new tables, reached through the existing
// owner-gated routes and no other door. Two things are pinned: the numbers
// actually arrive, and the cost half never claims more than it knows.
// ---------------------------------------------------------------------------

/**
 * A db stub that answers the list route's five queries and COUNTS them.
 * The count is the point: the whole design of the stats query is that it is
 * flat in round trips no matter how many accounts there are, and the only way
 * that stays true is if somebody asserts it.
 */
function statsDb({ accounts = 3, workspacesPerAccount = 2 } = {}) {
 const issued = [];
 const db = async (sql, params = []) => {
  const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  issued.push(text);
  if (/count\(\*\) as total from app_users/.test(text)) return [{ total: String(accounts) }];
  if (/usage\.metering_started_at/.test(text)) {
   return [{ configured_start: '2026-07-01T00:00:00.000Z', first_event_at: null, last_event_at: null }];
  }
  if (text.startsWith('with ws as (')) {
   const rows = [];
   for (let a = 0; a < accounts; a += 1) {
    for (let w = 0; w < workspacesPerAccount; w += 1) {
     rows.push({
      workspace_id: `ws-${a}-${w}`,
      user_id: `acc-${a}`,
      channel_count: '2', dm_count: '1', thread_count: '1',
      message_count: '10', agent_message_count: '6', human_message_count: '4',
      huddle_count: '1', live_huddle_count: '0', huddle_seconds: '60',
      agent_count: '1', live_daemon_count: '0',
      document_count: '1', member_count: '1',
      last_activity_at: '2026-07-20T00:00:00.000Z',
     });
    }
   }
   return rows;
  }
  if (/from usage_events/.test(text)) {
   return [{
    workspace_id: 'ws-0-0', provider: 'anthropic', resource: 'claude-haiku-4-5',
    calls: '2', input_units: '1000000', output_units: '0',
    cache_write_units: '0', cache_read_units: '0',
   }];
  }
  return Array.from({ length: accounts }, (_unused, index) => ({
   id: `acc-${index}`, email: `a${index}@x.test`,
   owned_workspace_count: String(workspacesPerAccount), membership_count: '0',
  }));
 };
 return { db, issued, params: [] };
}

test('the account list is FLAT in round trips — no per-account counting', async () => {
 // The naive version of this feature is a scalar sub-select per account per
 // statistic. This asserts the shape that avoids it: one grouped pass over the
 // workspaces, one over the usage ledger, and nothing that scales with N.
 const small = statsDb({ accounts: 2 });
 await tenantAdmin.listTenantAccounts(small.db);
 const large = statsDb({ accounts: 400 });
 await tenantAdmin.listTenantAccounts(large.db);
 assert.equal(
  small.issued.length,
  large.issued.length,
  'the number of queries must not depend on the number of accounts',
 );
 assert.equal(large.issued.length, 5, `expected 5 queries for the whole list, got ${large.issued.length}`);
});

test('per-workspace rows roll up to the OWNING account, never to every member', async () => {
 // Counting a shared workspace against every member would make the deployment
 // look several times busier than it is, and would bill the same tokens twice.
 const { db } = statsDb({ accounts: 2, workspacesPerAccount: 3 });
 const { accounts } = await tenantAdmin.listTenantAccounts(db);
 assert.equal(accounts.length, 2);
 assert.equal(accounts[0].stats.workspace_count, 3);
 assert.equal(accounts[0].stats.message_count, 30);
 assert.equal(accounts[0].stats.agent_message_count, 18);
});

test('an ownerless workspace is dropped rather than attributed to someone', () => {
 const rolled = tenantAdmin.rollUpAccountStats(
  [
   { workspace_id: 'ws-1', user_id: 'acc-1', message_count: '5' },
   { workspace_id: 'ws-2', user_id: null, message_count: '99' },
  ],
  [],
 );
 assert.equal(rolled.size, 1);
 assert.equal(rolled.get('acc-1').message_count, 5);
});

test('an account with no workspaces still gets a full zero-filled stats block', async () => {
 const { db } = statsDb({ accounts: 1, workspacesPerAccount: 0 });
 const { accounts } = await tenantAdmin.listTenantAccounts(db);
 // A missing `stats` would make every consumer write the same defensive
 // fallback, and one of them would eventually get it wrong.
 assert.deepEqual(Object.keys(accounts[0].stats).sort(), [
  ...Object.keys(tenantAdmin.emptyWorkspaceStats()),
  'usage',
  'workspace_count',
 ].sort());
 assert.equal(accounts[0].stats.usage.calls, 0);
});

test('the response carries the metering window, so a total can be labelled honestly', async () => {
 const { db } = statsDb();
 const result = await tenantAdmin.listTenantAccounts(db);
 assert.equal(result.metering.started_at, '2026-07-01T00:00:00.000Z');
 assert.match(result.metering.rates_as_of, /^\d{4}-\d{2}-\d{2}$/);
});

test('a database with no usage_events table reports "not started", not an error', async () => {
 // The Netlify lane runs no DDL of its own, so it can serve a request against a
 // database whose bootstrap has not run. That must degrade to an honest empty
 // window rather than 500-ing the only screen an operator has.
 const db = async (sql) => {
  const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  if (/usage_events/.test(text)) throw new Error('relation "usage_events" does not exist');
  if (/count\(\*\) as total from app_users/.test(text)) return [{ total: '1' }];
  if (text.startsWith('with ws as (')) return [];
  return [{ id: 'acc-1', email: 'a@x.test', owned_workspace_count: '0', membership_count: '0' }];
 };
 const result = await tenantAdmin.listTenantAccounts(db);
 assert.equal(result.metering.started_at, null);
 assert.equal(result.accounts[0].stats.usage.calls, 0);
});

test('the owner sees stats and cost; the numbers survive bigint strings', async () => {
 const { body } = await call('GET', '/backend/tenants', { token: tokenFor(OWNER_ID) });
 const owner = body.data.accounts.find((account) => account.id === OWNER_ID);
 assert.equal(owner.stats.message_count, 120);
 assert.equal(owner.stats.agent_message_count, 80);
 assert.equal(owner.stats.huddle_seconds, 3600);
 // 1M input tokens of Opus at $5/MTok.
 assert.equal(owner.stats.usage.usd, 5 + (200000 * 25 / 1e6));
 // Deepgram is metered but has no rate — its spend is NOT in the figure, and
 // the response says so rather than letting the total look complete.
 assert.deepEqual(owner.stats.usage.unpriced_providers, ['deepgram']);
 assert.equal(body.data.metering.started_at, METERING_STARTED_AT);
});

test('the detail pane gets per-workspace stats, and shared workspaces get NONE', async () => {
 const { body } = await call('GET', `/backend/tenants/${OWNER_ID}`, { token: tokenFor(OWNER_ID) });
 assert.equal(body.data.owned_workspaces.length, 1);
 assert.equal(body.data.owned_workspaces[0].stats.message_count, 120);
 assert.ok(body.data.owned_workspaces[0].usage);
 // A shared workspace's activity and bill belong to the account that OWNS it.
 // Repeating them here would let one workspace's spend be counted twice.
 for (const shared of body.data.member_workspaces) {
  assert.equal(shared.stats, undefined);
  assert.equal(shared.usage, undefined);
 }
});

test('no stats or cost route exists outside the owner gate', async () => {
 // The numbers ride the SAME three routes, which is why there is nothing new to
 // authorize. Any /usage or /stats path would be a second door to re-audit.
 assert.equal(/\/backend\/(tenants\/[^']*\/)?usage/.test(serverSource), false);
 assert.equal(/\/backend\/(tenants\/[^']*\/)?usage/.test(netlifySource), false);
 const { res } = await call('GET', '/backend/tenants', { token: tokenFor(MEMBER_ID) });
 assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------
// 6. Both backends, one gate — parity by source
// ---------------------------------------------------------------------------

test('BOTH backends register all three tenant routes — an admin route on one is a route nobody re-audits', () => {
 assert.match(serverSource, /app\.get\('\/backend\/tenants\/access', requireAuth,/);
 assert.match(serverSource, /app\.get\('\/backend\/tenants', requireAuth,/);
 assert.match(serverSource, /app\.get\('\/backend\/tenants\/:id', requireAuth,/);
 assert.match(netlifySource, /pathname === '\/backend\/tenants\/access'/);
 assert.match(netlifySource, /pathname === '\/backend\/tenants'/);
 assert.match(netlifySource, /\\\/backend\\\/tenants\\\/\(\[\^\/\]\+\)\$/);
});

test('both backends import the SHARED gate and neither hardcodes an owner address', () => {
 for (const [label, source] of [['server/index.cjs', serverSource], ['netlify', netlifySource]]) {
  assert.match(source, /assertSystemOwner/, `${label} must use the shared gate`);
  assert.match(source, /tenant-admin\.cjs/, `${label} must import it from shared/tenant-admin.cjs`);
  // No second owner-email resolution, and no literal address anywhere.
  assert.equal(
   /bouncingfish/i.test(source), false,
   `${label} must not hardcode an owner address — the gate reads AGENSIS_SYSTEM_OWNER_EMAIL`,
  );
  // Naming the var in a comment is fine (and useful); READING it is a second
  // owner resolution, which is exactly the copy that drifts.
  assert.equal(
   /process\.env\.AGENSIS_SYSTEM_OWNER_EMAIL|env\[['"]AGENSIS_SYSTEM_OWNER_EMAIL/.test(source), false,
   `${label} must not resolve AGENSIS_SYSTEM_OWNER_EMAIL itself; shared/tenant-admin.cjs owns that`,
  );
 }
});

test('the shared gate resolves the owner from the SAME env var ensureSystemWorkspace uses', () => {
 // One name, one secret. Two names would mean the System workspace and the admin
 // surface could disagree about who the operator is.
 assert.equal(tenantAdmin.SYSTEM_OWNER_EMAIL_ENV, 'AGENSIS_SYSTEM_OWNER_EMAIL');
 const coreSource = fs.readFileSync(path.join(root, 'shared/backend-core.cjs'), 'utf8');
 assert.match(coreSource, /AGENSIS_SYSTEM_OWNER_EMAIL/);
});

test('the shared gate does NOT inherit ensureSystemWorkspace\'s oldest-account fallback', () => {
 const source = fs.readFileSync(path.join(root, 'shared/tenant-admin.cjs'), 'utf8');
 // `order by created_at asc limit 1` over app_users with no id filter is the
 // fallback that makes ensureSystemWorkspace convenient and would make this
 // gate hand the deployment to whoever signed up first.
 assert.equal(
  /from app_users order by created_at/i.test(source.replace(/\s+/g, ' ')), false,
  'the owner check must never fall back to the oldest account',
 );
});

test('every tenant route on both backends is rate limited, reusing the existing limiters', () => {
 // Each request costs a DB lookup of the caller\'s email BEFORE it can be
 // refused, so an unlimited 403 is still a free query loop for any signed-up
 // account.
 const serverRoutes = serverSource.split(/app\.get\('\/backend\/tenants/).slice(1);
 assert.equal(serverRoutes.length, 3);
 for (const chunk of serverRoutes) {
  const body = chunk.slice(0, 900);
  assert.match(body, /dbRateLimitBlocked\(res, tenantsRateLimiter, tenantsDbRateLimiter/);
 }
 assert.match(serverSource, /const tenantsRateLimiter = createRateLimiter\(/);
 assert.match(serverSource, /tenantsDbRateLimiter = createDbRateLimiter\(\{[^}]*namespace: 'tenants'/);

 const netlifyRoutes = netlifySource.split(/pathname === '\/backend\/tenants|tenantDetailMatch\)/).slice(1);
 assert.ok(netlifyRoutes.length >= 3);
 assert.match(netlifySource, /const tenantsRateLimiter = createRateLimiter\(/);
 assert.match(netlifySource, /tenantsDbRateLimiter = createDbRateLimiter\(\{[^}]*namespace: 'tenants'/);
 assert.equal(
  (netlifySource.match(/dbRateLimitBlock\(tenantsRateLimiter, tenantsDbRateLimiter/g) || []).length, 3,
  'all three netlify tenant routes must run the layered limiter',
 );
});

test('the tenant routes are READ-ONLY — no write route exists on either backend yet', () => {
 // Upgrades and credits are a later pass. Until they are designed, there must be
 // nothing on this surface that can change an account.
 for (const [label, source] of [['server/index.cjs', serverSource], ['netlify', netlifySource]]) {
  for (const verb of ['post', 'patch', 'put', 'delete']) {
   assert.equal(
    new RegExp(`app\\.${verb}\\('/backend/tenants`).test(source), false,
    `${label} must not expose a ${verb.toUpperCase()} tenant route`,
   );
   assert.equal(
    new RegExp(`method === '${verb.toUpperCase()}' && pathname === '/backend/tenants`).test(source), false,
    `${label} must not expose a ${verb.toUpperCase()} tenant route`,
   );
  }
 }
 const source = fs.readFileSync(path.join(root, 'shared/tenant-admin.cjs'), 'utf8');
 for (const write of ['insert into', 'update ', 'delete from']) {
  assert.equal(
   source.toLowerCase().includes(write), false,
   `shared/tenant-admin.cjs must contain no ${write.trim()} statement`,
  );
 }
});

test('/backend/tenants/access is registered BEFORE /backend/tenants/:id on both backends', () => {
 // Otherwise "access" is swallowed as an account id: the button-visibility probe
 // would run the owner-gated detail route and 403 for every ordinary user.
 assert.ok(
  serverSource.indexOf("app.get('/backend/tenants/access'") < serverSource.indexOf("app.get('/backend/tenants/:id'"),
 );
 assert.ok(
  netlifySource.indexOf("pathname === '/backend/tenants/access'") < netlifySource.indexOf('tenantDetailMatch ='),
 );
});

test('the Tenants surface is not reachable through the generic /backend/db gate', () => {
 // app_users is deliberately NOT workspace-scoped and NOT insertable/updatable
 // through the query builder; the tenant list is a route precisely so it cannot
 // be reassembled by a client with a valid token and a clever filter.
 assert.equal(core.ALLOWED_TABLES.has('app_users'), true, 'self-profile reads still go through it');
 // The projection there is the same allow-list this surface derives from, so a
 // db/select of app_users cannot return a hash either.
 assert.throws(() => core.safeSelectColumns('app_users', 'password_hash'), { status: 403 });
 assert.throws(() => core.safeSelectColumns('app_users', 'id, token_version'), { status: 403 });
});
