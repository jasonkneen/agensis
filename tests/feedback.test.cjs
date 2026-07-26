// ============================================================================
// tests/feedback.test.cjs
// ----------------------------------------------------------------------------
// In-app feedback -> System workspace.
//
// Four things are worth pinning here, and they are all things a mocked DB can
// still prove:
//
//   1. READ vs SUBMIT authorization. Submitting is open to any signed-in user;
//      reading is members-of-the-System-workspace only. Both go through the
//      EXISTING guards, so the assertions are about registration in the shared
//      tables plus enforceDbOperationAccess's behaviour, not new code paths.
//
//   2. The jsonb bind, per backend. Verified against the live Neon database on
//      2026-07-26: postgres.js (Fly) turns JSON.stringify into a jsonb STRING
//      scalar, and @netlify/database (Neon/pg) throws on a bound raw array. The
//      two backends must therefore pass DIFFERENT jsonParam adapters, and
//      getting it backwards is silent on Fly. Asserted by inspecting the bound
//      parameter's JS type.
//
//   3. Server-side redaction. The browser redacts before sending; a request
//      that did not come from our browser did not. Both halves must carry the
//      same pattern set, so the CJS list and the TS list are compared by name.
//
//   4. The three schema places agree (ensureRuntimeSchema, neon-schema.sql, a
//      migration), and the route exists on BOTH backends — a route on one is a
//      live 404 for half the deployment.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const core = require('../shared/backend-core.cjs');

const serverSource = fs.readFileSync(path.join(root, 'server/index.cjs'), 'utf8');
const netlifySource = fs.readFileSync(path.join(root, 'netlify/functions/backend.mjs'), 'utf8');

// Shaped exactly like issueAuthToken's output.
const SESSION_TOKEN = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b.4.1785000000.Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl';

// ---------------------------------------------------------------------------
// 1. Authorization: read is workspace membership, submit is the dedicated route
// ---------------------------------------------------------------------------

test('feedback_reports is registered so the EXISTING db gate authorizes reads', () => {
 assert.equal(core.ALLOWED_TABLES.has('feedback_reports'), true);
 // Workspace-scoped is what makes enforceDbOperationAccess resolve the row's
 // workspace and demand membership of it. Without this the table would fall
 // through the tenancy check entirely.
 assert.equal(core.WORKSPACE_SCOPED_TABLES.has('feedback_reports'), true);

 const access = core.DB_TABLE_ACCESS.feedback_reports;
 assert.equal(access.select, 'read', 'reading a report must require membership of the System workspace');
 // NOT 'write': a browser must not be able to create a report through the
 // generic path, which would let it choose the destination workspace and skip
 // the rate limiter and the server-side redaction pass.
 assert.equal(access.insert, 'manage');
 assert.equal(access.update, 'manage');
 assert.equal(access.delete, 'manage');
});

function memberDb({ ownerOf = [], memberships = {}, reportWorkspace = 'sys-1' } = {}) {
 return async function db(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').toLowerCase();
  if (text.includes('from workspaces where id = $1 and user_id = $2')) {
   return ownerOf.includes(`${params[0]}:${params[1]}`) ? [{ 1: 1 }] : [];
  }
  if (text.includes('select role from workspace_members')) {
   const role = memberships[`${params[0]}:${params[1]}`];
   return role ? [{ role }] : [];
  }
  if (text.includes('from "feedback_reports" where id = $1')) {
   return [{ workspace_id: reportWorkspace }];
  }
  throw new Error(`Unexpected SQL: ${text}`);
 };
}

test('a non-member cannot read another user\'s feedback report', async () => {
 const db = memberDb({ memberships: {} });
 await assert.rejects(
  () => core.enforceDbOperationAccess({
   userId: 'reporter-1',
   table: 'feedback_reports',
   op: 'select',
   filters: [{ column: 'workspace_id', operator: 'eq', value: 'sys-1' }],
   db,
  }),
  (error) => error.status === 403,
 );
});

test('the reporter cannot read their OWN report back — they are not a System member', async () => {
 // Filtering by the report's id does not help: the gate resolves the row's
 // workspace and checks membership of THAT, not of anything the caller names.
 const db = memberDb({ memberships: {} });
 await assert.rejects(
  () => core.enforceDbOperationAccess({
   userId: 'reporter-1',
   table: 'feedback_reports',
   op: 'select',
   filters: [{ column: 'id', operator: 'eq', value: 'report-1' }],
   db,
  }),
  (error) => error.status === 403,
 );
});

test('a member of the System workspace CAN read reports', async () => {
 const db = memberDb({ memberships: { 'sys-1:owner-1': 'admin' } });
 await core.enforceDbOperationAccess({
  userId: 'owner-1',
  table: 'feedback_reports',
  op: 'select',
  filters: [{ column: 'workspace_id', operator: 'eq', value: 'sys-1' }],
  db,
 });
});

test('an editor of the System workspace cannot INSERT a report through the generic path', async () => {
 // 'editor' has 'write' but not 'manage', which is exactly the distinction the
 // table access map draws for this table.
 const db = memberDb({ memberships: { 'sys-1:editor-1': 'editor' } });
 await assert.rejects(
  () => core.enforceDbOperationAccess({
   userId: 'editor-1',
   table: 'feedback_reports',
   op: 'insert',
   payload: { values: { workspace_id: 'sys-1', description: 'x' } },
   db,
  }),
  (error) => error.status === 403,
 );
});

// ---------------------------------------------------------------------------
// 2. Validation, clamping and server-side redaction
// ---------------------------------------------------------------------------

test('normalizeFeedbackSubmission rejects an empty description', () => {
 assert.throws(() => core.normalizeFeedbackSubmission({ description: '  ' }), (error) => error.status === 400);
 assert.throws(() => core.normalizeFeedbackSubmission({}), (error) => error.status === 400);
});

test('normalizeFeedbackSubmission re-redacts server-side — the client may not have', () => {
 const submission = core.normalizeFeedbackSubmission({
  description: `broken, token was Bearer ${SESSION_TOKEN}`,
  page: { path: '/', hash: '', label: 'Personal' },
  diagnostics: {
   console: [{ level: 'log', message: `Authorization: Bearer ${SESSION_TOKEN}`, at: 1 }],
   errors: [{ kind: 'error', message: 'failed with aga_9f8e7d6c5b4a39281706', source: 'app.js', at: 2 }],
  },
 });
 const serialized = JSON.stringify(submission);
 // The whole point of duplicating the redactor into CJS.
 assert.equal(serialized.includes('Zm9vYmFy'), false);
 assert.equal(serialized.includes('aga_9f8e7d6c5b4a'), false);
 assert.match(submission.description, /broken/);
});

test('normalizeFeedbackSubmission clamps every unbounded field', () => {
 const submission = core.normalizeFeedbackSubmission({
  description: 'x'.repeat(50_000),
  page: { path: 'p'.repeat(2000), hash: 'h'.repeat(2000), label: 'l'.repeat(2000) },
  selections: Array.from({ length: 50 }, () => ({ selector: 's'.repeat(2000), tag: 'div', role: '', text: 't'.repeat(2000) })),
  diagnostics: {
   console: Array.from({ length: 5000 }, (_, i) => ({ level: 'log', message: `line ${i}`, at: i })),
   errors: Array.from({ length: 500 }, () => ({ kind: 'error', message: 'boom', source: '' })),
  },
 });
 assert.equal(submission.description.length, core.FEEDBACK_DESCRIPTION_MAX_CHARS);
 assert.equal(submission.selections.length, core.FEEDBACK_MAX_SELECTIONS);
 assert.equal(submission.page.path.length, 400);
 assert.ok(submission.diagnostics.console.length <= core.FEEDBACK_MAX_CONSOLE_ENTRIES);
 assert.ok(submission.diagnostics.errors.length <= 30);
});

test('normalizeFeedbackSubmission keeps the NEWEST console lines when it truncates', () => {
 const submission = core.normalizeFeedbackSubmission({
  description: 'broken',
  diagnostics: {
   console: Array.from({ length: 400 }, (_, i) => ({ level: 'log', message: `line ${i}`, at: i })),
  },
 });
 const messages = submission.diagnostics.console.map((entry) => entry.message);
 // The lines nearest the moment the user hit "report" are the ones that
 // explain the bug; dropping those instead would make the feature useless.
 assert.equal(messages[messages.length - 1], 'line 399');
 assert.equal(messages.includes('line 0'), false);
});

test('normalizeFeedbackSubmission enforces a hard byte ceiling on diagnostics', () => {
 // The realistic worst case: a full console ring buffer AND a full error
 // buffer, every entry at the per-entry cap. Per-entry + per-array clamping
 // alone leaves this over the limit, so the byte ceiling has to finish the job.
 const submission = core.normalizeFeedbackSubmission({
  description: 'broken',
  diagnostics: {
   console: Array.from({ length: 400 }, (_, i) => ({ level: 'log', message: `${i} ${'x'.repeat(900)}`, at: i })),
   errors: Array.from({ length: 40 }, (_, i) => ({ kind: 'error', message: `${i} ${'y'.repeat(900)}`, source: 's'.repeat(400), at: i })),
  },
 });
 assert.ok(
  JSON.stringify(submission.diagnostics).length <= core.FEEDBACK_DIAGNOSTICS_MAX_BYTES,
  'diagnostics blob must be bounded regardless of what the client sent',
 );
 assert.equal(submission.diagnostics.truncated, true);
 // Errors are never dropped by the ceiling — they are the smallest and most
 // valuable part of the payload; only the oldest console lines go.
 assert.equal(submission.diagnostics.errors.length, 30);
});

test('normalizeFeedbackSubmission survives a malformed payload instead of 500ing', () => {
 const submission = core.normalizeFeedbackSubmission({
  description: 'broken',
  page: 'not an object',
  selections: 'not an array',
  diagnostics: [1, 2, 3],
 });
 assert.deepEqual(submission.page, { path: '', hash: '', label: '' });
 assert.deepEqual(submission.selections, []);
 assert.equal(submission.diagnostics, null);
});

test('feedbackTaskTitle uses the first line and caps it', () => {
 assert.equal(core.feedbackTaskTitle('Dock overlaps composer\nmore detail'), 'Dock overlaps composer');
 assert.equal(core.feedbackTaskTitle(''), 'Feedback report');
 assert.ok(core.feedbackTaskTitle('x'.repeat(200)).length <= 90);
});

// ---------------------------------------------------------------------------
// 3. jsonb binding — the trap, per backend
// ---------------------------------------------------------------------------

function recordingDb() {
 const calls = [];
 const db = async (sql, params = []) => {
  const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  calls.push({ text, params });
  if (text.startsWith('select id from workspaces where is_system')) return [{ id: 'sys-1' }];
  if (text.startsWith('insert into tasks')) return [{ id: 'task-1' }];
  if (text.startsWith('insert into feedback_reports')) return [{ id: 'report-1' }];
  if (text.startsWith('update tasks set source_id')) return [];
  throw new Error(`Unexpected SQL: ${text}`);
 };
 db.calls = calls;
 return db;
}

const SUBMISSION = {
 description: 'Dock overlaps the composer',
 page: { path: '/', hash: '', label: 'Personal' },
 selections: [{ selector: '#dock', tag: 'div', role: '', text: 'Dock', rect: { x: 0, y: 0, width: 1, height: 1 } }],
 diagnostics: { buildId: 'abc', userAgent: 'UA', url: '/', language: 'en', capturedAt: '', viewport: { width: 1, height: 1 }, console: [], errors: [], truncated: false },
};

test('Fly binds jsonb params as OBJECTS (postgres.js turns a string into a jsonb string scalar)', async () => {
 const db = recordingDb();
 await core.insertFeedbackReport({
  db,
  jsonParam: (value) => value, // what server/index.cjs passes
  userId: 'user-1',
  sourceWorkspaceId: 'ws-9',
  submission: SUBMISSION,
 });
 const insert = db.calls.find((call) => call.text.startsWith('insert into feedback_reports'));
 const [, , , , , page, selections, diagnostics] = insert.params;
 assert.equal(typeof page, 'object', 'page must be bound as an object on postgres.js');
 assert.equal(Array.isArray(selections), true, 'selections must be bound as an array on postgres.js');
 assert.equal(typeof diagnostics, 'object');
});

test('Netlify binds jsonb params as JSON STRINGS (pg throws on a bound raw array)', async () => {
 const db = recordingDb();
 await core.insertFeedbackReport({
  db,
  jsonParam: (value) => JSON.stringify(value), // what netlify/functions/backend.mjs passes
  userId: 'user-1',
  sourceWorkspaceId: 'ws-9',
  submission: SUBMISSION,
 });
 const insert = db.calls.find((call) => call.text.startsWith('insert into feedback_reports'));
 const [, , , , , page, selections] = insert.params;
 assert.equal(typeof page, 'string');
 assert.equal(typeof selections, 'string');
 assert.deepEqual(JSON.parse(selections), SUBMISSION.selections);
});

test('each backend passes the jsonParam adapter its own driver needs', () => {
 // Source-level, because the difference is invisible to a mocked DB running
 // either backend's route: both "work", one silently corrupts the column.
 assert.match(serverSource, /jsonParam:\s*\(value\)\s*=>\s*value,/);
 assert.match(netlifySource, /jsonParam:\s*\(value\)\s*=>\s*JSON\.stringify\(value\),/);
});

// ---------------------------------------------------------------------------
// 4. Where the report lands, and who decides
// ---------------------------------------------------------------------------

test('the report lands in the System workspace, NOT the workspace the client named', async () => {
 const db = recordingDb();
 await core.insertFeedbackReport({
  db,
  jsonParam: (value) => value,
  userId: 'user-1',
  // A hostile client naming a workspace it controls must not redirect the report.
  sourceWorkspaceId: 'attacker-workspace',
  submission: SUBMISSION,
 });
 const taskInsert = db.calls.find((call) => call.text.startsWith('insert into tasks'));
 assert.equal(taskInsert.params[0], 'sys-1');
 const reportInsert = db.calls.find((call) => call.text.startsWith('insert into feedback_reports'));
 assert.equal(reportInsert.params[0], 'sys-1');
 // The caller's workspace is recorded as context only, in its own column.
 assert.equal(reportInsert.params[3], 'attacker-workspace');
});

test('a report is an ordinary task row — no parallel todo system', async () => {
 const db = recordingDb();
 const result = await core.insertFeedbackReport({
  db, jsonParam: (value) => value, userId: 'user-1', sourceWorkspaceId: null, submission: SUBMISSION,
 });
 const taskInsert = db.calls.find((call) => call.text.startsWith('insert into tasks'));
 assert.match(taskInsert.text, /insert into tasks \(workspace_id, created_by, title, description, status, priority, source_type, source_id\)/);
 assert.match(taskInsert.text, /'todo', 'normal', 'feedback'/);
 assert.equal(result.taskId, 'task-1');
 // source_id points back at the report, so the task alone finds the diagnostics.
 const link = db.calls.find((call) => call.text.startsWith('update tasks set source_id'));
 assert.deepEqual(link.params, ['report-1', 'task-1']);
});

test('ensureSystemWorkspace reuses the existing System workspace instead of creating another', async () => {
 const db = recordingDb();
 const id = await core.ensureSystemWorkspace(db);
 assert.equal(id, 'sys-1');
 assert.equal(db.calls.some((call) => call.text.startsWith('insert into workspaces')), false);
});

test('ensureSystemWorkspace creates one on first use, race-safe', async () => {
 const calls = [];
 let created = false;
 const db = async (sql, params = []) => {
  const text = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
  calls.push({ text, params });
  if (text.startsWith('select id from workspaces where is_system')) return created ? [{ id: 'sys-new' }] : [];
  if (text.startsWith('select id from app_users')) return [{ id: 'owner-1' }];
  if (text.startsWith('insert into workspaces')) { created = true; return []; }
  throw new Error(`Unexpected SQL: ${text}`);
 };
 const id = await core.ensureSystemWorkspace(db);
 assert.equal(id, 'sys-new');
 const insert = calls.find((call) => call.text.startsWith('insert into workspaces'));
 // `on conflict do nothing` + the partial unique index is what makes a
 // concurrent first submission on another instance safe: the loser re-reads.
 assert.match(insert.text, /on conflict do nothing/);
 assert.equal(insert.params[3], 'owner-1', 'ownership falls back to the oldest account');
});

// ---------------------------------------------------------------------------
// 5. Both backends, and the three schema places
// ---------------------------------------------------------------------------

test('POST /backend/feedback exists on BOTH backends', () => {
 assert.match(serverSource, /app\.post\('\/backend\/feedback', requireAuth,/);
 assert.match(netlifySource, /pathname === '\/backend\/feedback'/);
 assert.match(netlifySource, /await requireUserId\(req\)/);
});

test('the submit route is rate limited on BOTH backends', () => {
 // Submitting is open to every authenticated user, so this is the only thing
 // bounding one account's writes into the System workspace.
 assert.match(serverSource, /feedbackRateLimiter = createRateLimiter\(\{ windowMs: 60_000, max: 5 \}\)/);
 assert.match(serverSource, /dbRateLimitBlocked\(res, feedbackRateLimiter, feedbackDbRateLimiter/);
 assert.match(netlifySource, /feedbackRateLimiter = createRateLimiter\(\{ windowMs: 60_000, max: 5 \}\)/);
 assert.match(netlifySource, /dbRateLimitBlock\(feedbackRateLimiter, feedbackDbRateLimiter/);
});

test('both backends re-validate the body through the shared normalizer', () => {
 assert.match(serverSource, /normalizeFeedbackSubmission\(req\.body\)/);
 assert.match(netlifySource, /normalizeFeedbackSubmission\(body\)/);
});

test('the schema is in all THREE places', () => {
 const neonSchema = fs.readFileSync(path.join(root, 'database/neon-schema.sql'), 'utf8');
 const migrationsDir = path.join(root, 'supabase/migrations');
 const migration = fs.readdirSync(migrationsDir)
  .filter((name) => name.includes('feedback'))
  .map((name) => fs.readFileSync(path.join(migrationsDir, name), 'utf8'))
  .join('\n');

 assert.ok(migration.length > 0, 'a supabase migration for feedback must exist');

 for (const [label, source] of [['runtime', serverSource], ['neon-schema', neonSchema], ['migration', migration]]) {
  assert.match(source, /CREATE TABLE IF NOT EXISTS feedback_reports/, `${label} creates feedback_reports`);
  assert.match(source, /ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_system boolean/, `${label} adds workspaces.is_system`);
  // Singular System workspace, and what makes ensureSystemWorkspace race-safe.
  assert.match(source, /CREATE UNIQUE INDEX IF NOT EXISTS uq_workspaces_system/, `${label} enforces one System workspace`);
  // Without this the task insert fails the CHECK constraint on a live DB —
  // which a mocked-DB test could never catch.
  assert.match(source, /'canvas', 'ai', 'feedback'/, `${label} extends tasks_source_type_check`);
 }
});

// ---------------------------------------------------------------------------
// 6. Redaction parity between the TS client copy and the CJS server copy
// ---------------------------------------------------------------------------

test('the CJS and TS redaction pattern lists carry the same shapes', () => {
 const tsSource = fs.readFileSync(path.join(root, 'src/lib/feedbackRedaction.ts'), 'utf8');
 const tsNames = [...tsSource.matchAll(/name:\s*'([a-z0-9-]+)'/g)].map((match) => match[1]).sort();
 const cjsNames = core.FEEDBACK_REDACTION_PATTERNS.map((pattern) => pattern.name).sort();

 // Adding a token shape on one side and forgetting the other halves the
 // protection silently — the client would strip it and a direct POST would not.
 assert.deepEqual(cjsNames, tsNames);
 assert.ok(cjsNames.includes('agensis-session-token'));
 assert.ok(cjsNames.includes('agensis-agent-token'));
 assert.ok(cjsNames.includes('bearer-header'));
});

test('the server-side redactor strips this app\'s own credentials', () => {
 assert.equal(core.redactSecretsText(`Bearer ${SESSION_TOKEN}`).includes('Zm9vYmFy'), false);
 assert.equal(core.redactSecretsText('aga_9f8e7d6c5b4a39281706').includes('aga_9f8e'), false);
 const benign = 'GET /backend/workspaces 200 in 41ms';
 assert.equal(core.redactSecretsText(benign), benign);
});

test('redactSecretsDeep drops values under camelCase secret keys', () => {
 const out = core.redactSecretsDeep({ accessToken: 'novel-format-9910', sessionId: 'sess-1', author: 'Ada' });
 assert.equal(out.accessToken, '[redacted]');
 // Kept on purpose: neither is a credential, and both are useful in a report.
 assert.equal(out.sessionId, 'sess-1');
 assert.equal(out.author, 'Ada');
});
