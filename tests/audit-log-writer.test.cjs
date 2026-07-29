// ============================================================================
// tests/audit-log-writer.test.cjs
// ----------------------------------------------------------------------------
// recordAuditEntry — the only thing that writes audit_log.
//
// Drives the REAL exported function with a mock `db(sql, params)` and asserts on
// the CAPTURED PARAMS, never on the SQL text. A test that restates the INSERT's
// column list tests the mock; these assert what actually reaches the database.
//
// The secret-leak tests are the load-bearing ones and they assert over the WHOLE
// serialized param array, not per-field. A secret arriving through a nested
// `detail` key is the failure mode a per-field assertion misses, and it is the
// single highest-severity risk this feature has: audit_log has a longer
// retention than most tables and a manage-gated read an owner will grep.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  recordAuditEntry, auditEntryHash, auditEmailDomain, sanitizeAuditDetail, AUDIT_ACTIONS,
} = require('../shared/backend-core.cjs');

/** Mock db with the core's `db(sql, params) => rows[]` shape. */
function makeDb({ throws = false } = {}) {
  const calls = [];
  async function db(sql, params = []) {
    calls.push({ sql, params });
    if (throws) throw new Error('database is on fire');
    return [{ id: 'row-1', seq: 7, entry_hash: params[12] }];
  }
  db.calls = calls;
  return db;
}

/** The param array as one string — how a leak is actually found. */
function serialized(db) {
  return JSON.stringify(db.calls[0]?.params ?? []);
}

const baseEntry = {
  workspaceId: 'ws-1',
  actor: { userId: 'user-1' },
  action: 'member.role_changed',
  target: { type: 'workspace_member', id: 'member-1' },
  before: 'editor',
  after: 'admin',
};

test('a valid entry inserts once and returns the row', async () => {
  const db = makeDb();
  const result = await recordAuditEntry({ db, ...baseEntry });
  assert.equal(db.calls.length, 1);
  assert.deepEqual(result, { id: 'row-1', seq: 7, entry_hash: db.calls[0].params[12] });
  const params = db.calls[0].params;
  assert.equal(params[0], 'ws-1');
  assert.equal(params[1], 'user-1');
  assert.equal(params[2], null, 'actor_agent_id must be null when a user acted');
  assert.equal(params[4], 'member.role_changed');
  assert.equal(params[8], 'editor');
  assert.equal(params[9], 'admin');
});

test('detail is bound as an OBJECT, never a JSON string', async () => {
  // MUTATION: bind JSON.stringify(row.detail) in recordAuditEntry -> this fails.
  // porsager turns a stringified ::jsonb bind into a jsonb STRING SCALAR; the
  // repo has 39 corrupted rows across four tables from exactly that mistake.
  const db = makeDb();
  await recordAuditEntry({ db, ...baseEntry, detail: { key: 'ANTHROPIC_API_KEY', configured: true } });
  const detailParam = db.calls[0].params[10];
  assert.equal(typeof detailParam, 'object');
  assert.equal(Array.isArray(detailParam), false);
  assert.deepEqual(detailParam, { configured: true, key: 'ANTHROPIC_API_KEY' });
});

test('entry_hash is 64 hex chars and covers the row content', async () => {
  // MUTATION: drop the hash computation (leave entry_hash '') -> first assert fails.
  // MUTATION: hash a constant -> the change assert fails.
  const db = makeDb();
  await recordAuditEntry({ db, ...baseEntry });
  const hash = db.calls[0].params[12];
  assert.match(hash, /^[0-9a-f]{64}$/);

  const row = {
    workspace_id: 'ws-1', actor_user_id: 'u', actor_agent_id: '', action: 'a',
    target_type: 't', target_id: 'i', before_value: 'x', after_value: 'y',
    detail: { b: 2, a: 1 }, created_at: '2026-07-29T00:00:00.000Z',
  };
  const original = auditEntryHash(row);
  for (const field of ['workspace_id', 'action', 'before_value', 'after_value', 'created_at', 'target_id']) {
    assert.notEqual(auditEntryHash({ ...row, [field]: 'CHANGED' }), original, `${field} must be hashed`);
  }
  assert.notEqual(auditEntryHash({ ...row, detail: { a: 1, b: 3 } }), original, 'detail must be hashed');
  // Key order must not change the hash, or a re-serialised row would look edited.
  assert.equal(auditEntryHash({ ...row, detail: { a: 1, b: 2 } }), original);
});

test('a vault entry carries the key NAME and no value anywhere in the params', async () => {
  // MUTATION: pass the secret through in detail (or in after) -> this fails.
  const SECRET = 'testkey-ant-api03-REALKEYMATERIAL-do-not-log';
  const db = makeDb();
  await recordAuditEntry({
    db,
    workspaceId: 'ws-1',
    actor: { userId: 'user-1' },
    action: 'vault.secret_set',
    target: { type: 'vault_secret', id: 'ANTHROPIC_API_KEY', label: 'ANTHROPIC_API_KEY' },
    after: 'configured',
    detail: { key: 'ANTHROPIC_API_KEY', configured: true },
  });
  const all = serialized(db);
  assert.equal(all.includes(SECRET), false);
  assert.equal(all.includes('testkey-ant'), false);
  assert.equal(all.includes('ANTHROPIC_API_KEY'), true, 'the key NAME is the useful part and must survive');
});

test('a nested object in detail cannot smuggle a secret through', async () => {
  // The failure mode a per-field assertion misses: someone writes
  // `detail: { agent: agentRow }` and the row's connect_token_hash rides along.
  // MUTATION: make sanitizeAuditDetail recurse into objects instead of dropping
  // them -> this fails.
  const db = makeDb();
  await recordAuditEntry({
    db,
    ...baseEntry,
    action: 'agent.connect_token_minted',
    detail: {
      handle: 'scout',
      agent: { id: 'a1', connect_token_hash: 'HASHEDTOKENMATERIAL', secret_cipher: 'CIPHERTEXT' },
    },
  });
  const all = serialized(db);
  assert.equal(all.includes('HASHEDTOKENMATERIAL'), false);
  assert.equal(all.includes('CIPHERTEXT'), false);
  assert.equal(all.includes('connect_token_hash'), false);
  assert.equal(all.includes('scout'), true);
});

test('a connect-token entry carries neither the token nor its hash', async () => {
  const TOKEN = 'aga_live_TOKENMATERIALTOKENMATERIAL';
  const db = makeDb();
  await recordAuditEntry({
    db,
    workspaceId: 'ws-1',
    actor: { userId: 'user-1' },
    action: 'agent.connect_token_minted',
    target: { type: 'agent', id: 'agent-1', label: 'scout' },
    before: 'default',
    after: 'yolo',
    detail: { handle: 'scout', model: 'claude-opus-5' },
  });
  const all = serialized(db);
  assert.equal(all.includes(TOKEN), false);
  assert.equal(all.includes('aga_'), false);
  // The resulting permission mode IS recorded — that is the point of the row.
  assert.equal(db.calls[0].params[9], 'yolo');
});

test('an invite entry records the email DOMAIN and never the local-part', async () => {
  // MUTATION: record the full email -> this fails.
  assert.equal(auditEmailDomain('Alice.Smith+tag@example.com'), 'example.com');
  assert.equal(auditEmailDomain('not-an-email'), '');
  assert.equal(auditEmailDomain(''), '');

  const db = makeDb();
  await recordAuditEntry({
    db,
    workspaceId: 'ws-1',
    actor: { userId: 'user-1' },
    action: 'invite.created',
    target: { type: 'workspace_invite', id: 'inv-1' },
    after: 'admin',
    detail: { email_domain: auditEmailDomain('alice.smith@example.com'), external: true },
  });
  const all = serialized(db);
  assert.equal(all.includes('alice.smith'), false);
  assert.equal(all.includes('alice'), false);
  assert.equal(all.includes('example.com'), true);
});

test('a throwing db does not reject and does not lose the caller', async () => {
  // MUTATION: remove the try/catch in recordAuditEntry -> this fails.
  // An audit write must never turn a successful role change into a 500.
  const db = makeDb({ throws: true });
  const result = await recordAuditEntry({ db, ...baseEntry });
  assert.equal(result, null);
});

test('a missing db does not reject either', async () => {
  assert.equal(await recordAuditEntry({ ...baseEntry }), null);
});

test('an unknown action never persists under its own name', async () => {
  // MUTATION: remove the AUDIT_ACTIONS check -> both halves fail.
  // Outside production the writer refuses outright (loud at the desk, no row).
  const db = makeDb();
  assert.equal(await recordAuditEntry({ db, ...baseEntry, action: 'member.role_chnaged' }), null);
  assert.equal(db.calls.length, 0, 'a typo must not reach the table at all in development');

  // In production the ACTION still leaves a row, recorded as 'unknown' so it is
  // visible rather than lost — but never under the typo'd name, which would be
  // unfilterable.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const prodDb = makeDb();
    await recordAuditEntry({ db: prodDb, ...baseEntry, action: 'member.role_chnaged' });
    assert.equal(prodDb.calls.length, 1);
    assert.equal(prodDb.calls[0].params[4], 'unknown');
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('every registered action is namespaced and the registry is frozen', () => {
  assert.ok(AUDIT_ACTIONS.size >= 10);
  for (const action of AUDIT_ACTIONS) assert.match(action, /^[a-z_]+\.[a-z_]+$/);
  assert.equal(Object.isFrozen(AUDIT_ACTIONS), true);
});

test('actor_user_id and actor_agent_id are never both set', async () => {
  // MUTATION: set both unconditionally -> this fails. A verified session wins.
  const db = makeDb();
  await recordAuditEntry({ db, ...baseEntry, actor: { userId: 'user-1', agentId: 'agent-1' } });
  assert.equal(db.calls[0].params[1], 'user-1');
  assert.equal(db.calls[0].params[2], null);

  const agentDb = makeDb();
  await recordAuditEntry({ db: agentDb, ...baseEntry, actor: { agentId: 'agent-1' } });
  assert.equal(agentDb.calls[0].params[1], null);
  assert.equal(agentDb.calls[0].params[2], 'agent-1');
});

test('created_at is bound, not left to now(), so the hash covers the stored value', async () => {
  // MUTATION: write now() into the SQL and drop the bind -> this fails. The hash
  // would then cover a timestamp different from the one the row holds, and every
  // row would verify as tampered.
  const db = makeDb();
  await recordAuditEntry({ db, ...baseEntry });
  const createdAt = db.calls[0].params[13];
  assert.match(createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  assert.equal(/now\(\)/i.test(db.calls[0].sql), false);
});

test('sanitizeAuditDetail bounds what one row can carry', () => {
  // Structural guard against `detail: wholeRow`. Strings clamp, objects drop.
  const long = 'x'.repeat(5000);
  const out = sanitizeAuditDetail({
    text: long,
    n: 42,
    flag: true,
    nested: { secret: 'nope' },
    list: ['a', { secret: 'nope' }, 3],
    nothing: null,
  });
  assert.equal(out.text.length, 200);
  assert.equal(out.n, 42);
  assert.equal(out.flag, true);
  assert.equal('nested' in out, false, 'nested objects are dropped, not stringified');
  assert.deepEqual(out.list, ['a', 3], 'objects inside arrays are dropped too');
  assert.equal('nothing' in out, false);
  assert.deepEqual(sanitizeAuditDetail(null), {});
  assert.deepEqual(sanitizeAuditDetail('a string'), {});
  assert.deepEqual(sanitizeAuditDetail(['an', 'array']), {});
});

test('long text fields cannot make a row unbounded', async () => {
  const db = makeDb();
  await recordAuditEntry({
    db,
    ...baseEntry,
    before: 'y'.repeat(9000),
    after: 'z'.repeat(9000),
    target: { type: 't'.repeat(500), id: 'i'.repeat(500), label: 'l'.repeat(500) },
  });
  const params = db.calls[0].params;
  assert.equal(params[5].length, 60);
  assert.equal(params[6].length, 120);
  assert.equal(params[7].length, 160);
  assert.equal(params[8].length, 200);
  assert.equal(params[9].length, 200);
});
