'use strict';

// ============================================================================
// tests/audit-log-call-sites.test.cjs
// ----------------------------------------------------------------------------
// The privileged routes actually WRITE an audit row — driven end to end through
// the real express app, so this covers the wiring (deps threaded into each
// extracted route module, actor taken from the verified session, before-value
// actually captured) and not just recordAuditEntry in isolation.
//
// It also re-asserts the REDACTION CONTRACT at the real call sites, over the
// whole captured param array. tests/audit-log-writer.test.cjs proves the writer
// cannot leak what it is handed; these prove the call sites do not hand it a
// secret in the first place. Both halves are needed — the writer test would pass
// happily while a route passed a vault value straight into `after`.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createApp, __test } = require('../server/index.cjs');

const USER = 'user-1';
const WORKSPACE = 'w1';
const MEMBER = 'member-1';
const AGENT = 'agent-1';

test.afterEach(() => __test.resetTestState());

/**
 * Fake db that answers the statements these routes issue and records every
 * `insert into audit_log`. `rows` lets a test control what a mutation returns.
 */
function makeDb({ rows = {}, role = 'owner' } = {}) {
  const audits = [];
  const queries = [];
  const db = {
    audits,
    queries,
    async unsafe(sql, params = []) {
      const raw = String(sql).replace(/\s+/g, ' ').trim();
      const q = raw.toLowerCase();
      if (!/^create |^drop |^alter |^do \$\$/.test(q)) queries.push({ sql: raw, params });

      if (q.startsWith('insert into audit_log')) {
        audits.push({ sql: raw, params });
        return [{ id: `audit-${audits.length}`, seq: audits.length, entry_hash: params[12] }];
      }
      if (q.startsWith('select value from app_settings')) {
        return params[0] === 'AUTH_SECRET' ? [{ value: 'audit-secret' }] : [];
      }
      if (q.startsWith('select token_version from app_users')) return [{ token_version: '1' }];
      if (q.startsWith('select 1 from workspaces where id')) {
        return role === 'owner' && String(params[1]) === USER ? [{ ok: 1 }] : [];
      }
      if (q.startsWith('select role from workspace_members')) {
        return role && role !== 'owner' && role !== 'none' ? [{ role }] : [];
      }
      if (q.includes('with recursive chain as')) return [];
      if (/^select workspace_id from "?[a-z_]+"? where id/.test(q)) return [{ workspace_id: WORKSPACE }];

      for (const [match, value] of Object.entries(rows)) {
        if (q.startsWith(match)) return typeof value === 'function' ? value(params) : value;
      }
      return [];
    },
  };
  return db;
}

async function withServer(fn) {
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
}

async function call(baseUrl, method, path, token, body) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** One audit row's params, by column name. */
function audit(db, index = 0) {
  const params = db.audits[index]?.params;
  if (!params) return null;
  const [workspace_id, actor_user_id, actor_agent_id, actor_label, action,
    target_type, target_id, target_label, before_value, after_value,
    detail, request_ip, entry_hash, created_at] = params;
  return {
    workspace_id, actor_user_id, actor_agent_id, actor_label, action,
    target_type, target_id, target_label, before_value, after_value,
    detail, request_ip, entry_hash, created_at,
    serialized: JSON.stringify(params),
  };
}

test('a member role change writes member.role_changed with the OLD role', async () => {
  // MUTATION: revert the UPDATE to the plain `returning *` form (no prev join)
  // -> before_value is '' and this fails. The whole content of the row is
  // "from WHAT to what".
  const db = makeDb({
    rows: {
      'update workspace_members m set role': [{
        id: MEMBER, workspace_id: WORKSPACE, user_id: 'user-2', role: 'admin',
        audit_previous_role: 'editor',
      }],
    },
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'PATCH', `/backend/workspaces/${WORKSPACE}/members/${MEMBER}`, token, { role: 'admin' });
    assert.equal(res.status, 200);
    const body = await res.json();
    // The joined-in audit column must not reach the client or realtime.
    assert.equal('audit_previous_role' in body.data, false);
  });

  assert.equal(db.audits.length, 1);
  const row = audit(db);
  assert.equal(row.action, 'member.role_changed');
  assert.equal(row.actor_user_id, USER, 'the actor is the VERIFIED session, never a body field');
  assert.equal(row.before_value, 'editor');
  assert.equal(row.after_value, 'admin');
  assert.equal(row.target_type, 'workspace_member');
  assert.equal(row.target_id, MEMBER);
  assert.match(row.entry_hash, /^[0-9a-f]{64}$/);
});

test('a member removal writes member.removed, and a no-op DELETE writes nothing', async () => {
  const db = makeDb({
    rows: { 'delete from workspace_members': [{ id: MEMBER, workspace_id: WORKSPACE, user_id: 'user-2', role: 'editor' }] },
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await call(baseUrl, 'DELETE', `/backend/workspaces/${WORKSPACE}/members/${MEMBER}`, token)).status, 200);
  });
  assert.equal(db.audits.length, 1);
  assert.equal(audit(db).action, 'member.removed');
  assert.equal(audit(db).before_value, 'editor');

  // MUTATION: drop the `if (rows[0])` guard -> this half fails. A DELETE that
  // matched nothing is not a removal, and logging it puts phantoms in the log.
  const empty = makeDb({ rows: { 'delete from workspace_members': [] } });
  __test.setTestDb(empty);
  const token2 = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await call(baseUrl, 'DELETE', `/backend/workspaces/${WORKSPACE}/members/${MEMBER}`, token2)).status, 200);
  });
  assert.equal(empty.audits.length, 0);
});

test('an invite records the email DOMAIN and never the token or the local-part', async () => {
  // MUTATION: put `email` (not auditEmailDomain(email)) in detail -> fails.
  // MUTATION: add the token to detail -> fails.
  const db = makeDb({
    rows: { 'insert into workspace_invites': [{ id: 'inv-1', workspace_id: WORKSPACE, role: 'admin', status: 'pending' }] },
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  let plaintextToken = '';
  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/backend/workspaces/${WORKSPACE}/invites`, token, {
      role: 'admin', email: 'Alice.Smith@partner-corp.com',
    });
    assert.equal(res.status, 200);
    plaintextToken = (await res.json()).data.token;
    assert.ok(plaintextToken, 'the route still returns the plaintext token once');
  });

  assert.equal(db.audits.length, 1);
  const row = audit(db);
  assert.equal(row.action, 'invite.created');
  assert.equal(row.after_value, 'admin');
  assert.equal(row.serialized.includes(plaintextToken), false, 'the invite TOKEN must never be in the log');
  assert.equal(row.serialized.toLowerCase().includes('alice'), false, 'no local-part');
  assert.equal(row.detail.email_domain, 'partner-corp.com');
});

test('a vault write records the key NAME and never the value', async () => {
  // The highest-severity thing this feature could get wrong.
  // MUTATION: put the value into `after` or into detail -> fails.
  const SECRET = 'sk-live-REALSECRETVALUE-1234567890';
  const db = makeDb();
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'PUT', `/backend/workspaces/${WORKSPACE}/vault/STRIPE_KEY`, token, {
      value: SECRET, description: 'billing',
    });
    assert.equal(res.status, 200);
  });

  assert.equal(db.audits.length, 1);
  const row = audit(db);
  assert.equal(row.action, 'vault.secret_set');
  assert.equal(row.after_value, 'configured');
  assert.equal(row.serialized.includes(SECRET), false);
  assert.equal(row.serialized.includes('sk-live'), false);
  assert.equal(row.detail.key, 'STRIPE_KEY', 'the key NAME is what makes the row useful');
  assert.equal(row.detail.configured, true);

  // Deleting the same key is a different action, not the same one with a flag.
  const del = makeDb();
  __test.setTestDb(del);
  const token2 = await __test.issueToken(USER, '1');
  await withServer(async (baseUrl) => {
    assert.equal((await call(baseUrl, 'DELETE', `/backend/workspaces/${WORKSPACE}/vault/STRIPE_KEY`, token2)).status, 200);
  });
  assert.equal(audit(del).action, 'vault.secret_deleted');
});

test('a permission_mode flip to yolo is recorded with the mode it came from', async () => {
  // THE highest-value row in this log: 'yolo' is unrestricted shell on the
  // daemon host, and nothing anywhere recorded who granted it.
  // MUTATION: remove the recordAudit call in setAgentPermissionMode -> fails.
  const db = makeDb({
    rows: {
      'update workspace_agents a set permission_mode': [{
        id: AGENT, workspace_id: WORKSPACE, handle: 'scout', name: 'Scout',
        permission_mode: 'yolo', audit_previous_permission_mode: 'default',
      }],
    },
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await call(
      baseUrl, 'PUT', `/backend/workspaces/${WORKSPACE}/agents/${AGENT}/permission-mode`, token,
      { permission_mode: 'yolo' },
    );
    assert.equal(res.status, 200);
  });

  assert.equal(db.audits.length, 1);
  const row = audit(db);
  assert.equal(row.action, 'agent.permission_mode_changed');
  assert.equal(row.actor_user_id, USER);
  assert.equal(row.before_value, 'default');
  assert.equal(row.after_value, 'yolo');
  assert.equal(row.target_id, AGENT);
  assert.equal(row.target_label, 'scout');
});

test('minting the workspace MCP token is recorded, and the token never reaches the row', async () => {
  // agw_ is the workspace's control-plane secret: a bearer reaches all 29 MCP
  // tools and can mint an agent's daemon token via get_connect_command. Minting
  // also ROTATES it, so every MCP client holding the old one breaks at that
  // moment. Its sibling agent.connect_token_minted was audited from the start;
  // this call site was not, which is the gap this test closes.
  const db = makeDb({
    rows: {
      'update workspaces set mcp_token_hash': () => [{ id: WORKSPACE, mcp_auto_approve: true }],
    },
  });
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  const body = await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'POST', `/backend/workspaces/${WORKSPACE}/mcp-token`, token, {});
    assert.equal(res.status, 200);
    return res.json();
  });

  // The response really does carry a live credential -- that is what makes the
  // redaction assertion below meaningful rather than trivially true.
  assert.match(body.data.token, /^agw_/, 'the route returns a live token');

  const row = audit(db, 0);
  assert.ok(row, 'a mint must write exactly one audit row');
  assert.equal(row.action, 'workspace.mcp_token_minted');
  assert.equal(row.actor_user_id, USER, 'the actor comes from the verified session');
  assert.equal(row.workspace_id, WORKSPACE);
  assert.equal(row.target_type, 'workspace');
  assert.equal(row.target_id, WORKSPACE);

  // The redaction contract, over the WHOLE param array: neither the token nor
  // its hash may appear anywhere in the row, including inside `detail`.
  assert.ok(!row.serialized.includes(body.data.token), 'the token must never reach the audit row');
  assert.ok(!/agw_/.test(row.serialized), 'not even a fragment of a token');
  const hash = require('node:crypto').createHash('sha256').update(body.data.token).digest('hex');
  assert.ok(!row.serialized.includes(hash), 'nor the hash -- it is a verifier, so it is still a secret');

  // What IS worth recording: whether a bearer of this token registers as an
  // agent with no approval popup. `detail` is bound as an object (jsonParam
  // defaults to identity for postgres.js on Fly), not a JSON string.
  assert.deepEqual(row.detail, { autoApprove: true, rotated: true });
});

test('the joined-in audit column never rides the realtime fanout', async () => {
  // Both UPDATEs join a `prev` row in to capture the before-value. That extra
  // column must be stripped before notifyDbSubscribers, or every subscribed
  // browser starts receiving an internal field on the agent/member row.
  // MUTATION: pass `rows` instead of `publicRows` to notifyDbSubscribers -> fails.
  const source = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../server/agent-permissions.cjs'), 'utf8',
  );
  assert.match(source, /notifyDbSubscribers\('workspace_agents', 'UPDATE', publicRows\)/);
  const members = require('node:fs').readFileSync(
    require('node:path').resolve(__dirname, '../server/members-invites-routes.cjs'), 'utf8',
  );
  assert.match(members, /notifyDbSubscribers\('workspace_members', 'UPDATE', publicRows\)/);
});

test('a failing audit write never breaks the privileged action it observes', async () => {
  // MUTATION: remove the try/catch in recordAuditEntry -> the role change 500s.
  // This is risk #2 in the plan: an audit write that throws inside a role-change
  // handler turns a working feature into an outage.
  const db = makeDb({
    rows: {
      'update workspace_members m set role': [{
        id: MEMBER, workspace_id: WORKSPACE, user_id: 'user-2', role: 'admin', audit_previous_role: 'editor',
      }],
    },
  });
  const inner = db.unsafe.bind(db);
  db.unsafe = async (sql, params) => {
    if (String(sql).toLowerCase().includes('insert into audit_log')) throw new Error('audit table is gone');
    return inner(sql, params);
  };
  __test.setTestDb(db);
  const token = await __test.issueToken(USER, '1');

  await withServer(async (baseUrl) => {
    const res = await call(baseUrl, 'PATCH', `/backend/workspaces/${WORKSPACE}/members/${MEMBER}`, token, { role: 'admin' });
    assert.equal(res.status, 200, 'the role change must still succeed');
    assert.equal((await res.json()).data.role, 'admin');
  });
});

test('every action the call sites emit is in the AUDIT_ACTIONS registry', () => {
  // A call site naming an action the registry does not know would record as
  // 'unknown' in production — visible, but unfilterable. Catch it here instead.
  const fs = require('node:fs');
  const path = require('node:path');
  const { AUDIT_ACTIONS } = require('../shared/backend-core.cjs');
  const dir = path.resolve(__dirname, '../server');
  const used = new Set();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.cjs')) continue;
    const source = fs.readFileSync(path.join(dir, name), 'utf8');
    for (const match of source.matchAll(/action:\s*'([a-z_]+\.[a-z_]+)'/g)) used.add(match[1]);
    // The vault routes pick their action with a ternary.
    for (const match of source.matchAll(/\?\s*'([a-z_]+\.[a-z_]+)'\s*:\s*'([a-z_]+\.[a-z_]+)'/g)) {
      used.add(match[1]);
      used.add(match[2]);
    }
  }
  assert.ok(used.size >= 8, `expected the call sites to be found, saw ${used.size}`);
  for (const action of used) {
    assert.equal(AUDIT_ACTIONS.has(action), true, `${action} is emitted but not registered`);
  }
});
