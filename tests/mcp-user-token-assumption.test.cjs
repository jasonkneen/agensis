'use strict';

// ============================================================================
// tests/mcp-user-token-assumption.test.cjs
// ----------------------------------------------------------------------------
// A user's ORDINARY LOGIN TOKEN authenticates at the MCP endpoint.
//
// `verifyMcpToken` falls through six verifiers and the last one is
// `verifyUserAuthMcpToken`, which takes an agensis session token and resolves it
// to a workspace identity. This is DELIBERATE — it arrived with the MCP client
// registration approval flow, the fall-through order is spelled out in a comment
// above `verifyMcpToken`, and `get_connect_command` carries a per-kind branch
// that specifically re-checks the manage role for `kind === 'user'`. It is not
// an accident, and this file is not claiming it is a bug.
//
// It is pinned here because the CONSEQUENCES are invisible at the call site and
// nothing else in the suite states them:
//
//   1. The credential is the human's own session token. It is the same string
//      that authorizes every /backend/db/* request through `requireAuth`, so a
//      copy pasted into a third-party MCP client's config file is a full-account
//      credential sitting in plaintext on disk. MCP acceptance does not GRANT
//      that reach -- the token always had it -- but it does create a second
//      place the token is written down.
//   2. It cannot be revoked on its own. Revocation is `token_version` on
//      app_users, a per-user counter, so revoking the pasted copy signs the
//      human out everywhere. The purpose-built agw_ token revokes by re-minting
//      and affects MCP clients only.
//   3. It has no prefix. aga_/agw_/agx_/agf_/agc_/ago_/cbk_ are all
//      pattern-matchable, so a redactor can strip them from a log, a transcript
//      or a screenshot. A
//      session token cannot be recognised by shape.
//   4. It expires in 14 days (DEFAULT_TOKEN_TTL_SEC), so a working MCP config
//      silently starts 401ing. agw_ does not expire.
//   5. It resolves to the user's OLDEST OWNED workspace, not the one they are
//      looking at -- `order by created_at asc limit 1`.
//
// And the reason all five matter: a login token reaches EXACTLY the same tools
// as the agw_ workspace token, which is owner-only to mint, revocable, prefixed,
// non-expiring, and the only thing the UI ever mints (src/lib/mcpConnect.ts).
// That equality is asserted below, because it is the fact that decides whether
// this path is worth keeping.
//
// IF YOU CHANGE THE AUTH CHAIN, THIS FILE GOES RED. That is the point: update it
// and the "Login tokens at the MCP door" section of AGENTS.md together. Do not
// delete it to make a change pass.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');
const { __test: mcpTest } = require('../server/mcp.cjs');

const { verifyUserAuthMcpToken, verifyWorkspaceMcpToken, setTestDb, resetTestState } = __test;

const WS_OLDEST = 'ws-oldest';
const USER = 'user-1';

function makeDb(handlers = []) {
  const db = {
    calls: [],
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim().toLowerCase();
      db.calls.push({ n, params });
      for (const h of handlers) {
        if (h.match.test(n)) return typeof h.rows === 'function' ? h.rows(params, n) : (h.rows || []);
      }
      return [];
    },
  };
  return db;
}
function use(handlers) { const db = makeDb(handlers); setTestDb(db); return db; }
test.afterEach(() => resetTestState());

// ---------------------------------------------------------------------------
// The decisive fact. If these two sets ever differ, the login-token path starts
// granting something agw_ does not, and the trade-off in AGENTS.md changes.
// ---------------------------------------------------------------------------
test('a login token reaches exactly the tools the agw_ workspace token reaches', () => {
  const tools = mcpTest.buildTools();
  const reachableBy = (kind) => tools.filter((t) => t.kinds.includes(kind)).map((t) => t.name).sort();

  const byUser = reachableBy('user');
  const byWorkspace = reachableBy('workspace');

  assert.deepEqual(
    byUser,
    byWorkspace,
    'A user login token and the agw_ workspace token reach different tool sets now. '
    + 'The argument for narrowing the login path rests on them being identical -- '
    + 'if that changed, re-read AGENTS.md "Login tokens at the MCP door" before proceeding.',
  );
  // Pinned literally, so "both shrank to zero" cannot pass this test.
  // 42 since react_to_message: it is offered to both credentials on the same
  // terms as post_message (an `as:` handle that is mcp_approved), so the sets
  // stayed identical and only the count moved.
  // 43 since list_comments, which is a READ and takes the default kinds. Its two
  // write siblings (reply_to_comment, resolve_comment) are `kinds: ['agent']` —
  // a comment authored through them is attributed to an agent, and a user token
  // has no agent id to stamp — so they are absent from both sets and the
  // equality above still holds for the reason it always did.
  assert.equal(byUser.length, 43);
  assert.ok(byUser.includes('get_connect_command'), 'including the tool that mints an aga_ daemon token');
  assert.ok(byUser.includes('register_agent'));
  for (const standingRuleTool of [
    'list_agent_permission_rules',
    'grant_agent_permission_rule',
    'revoke_agent_permission_rule',
  ]) {
    assert.ok(byWorkspace.includes(standingRuleTool), `the workspace credential must retain ${standingRuleTool}`);
  }
  for (const resourceLifecycleTool of ['delete_workspace_resource', 'restore_workspace_resource']) {
    assert.ok(byWorkspace.includes(resourceLifecycleTool), `the workspace credential must retain ${resourceLifecycleTool}`);
  }
  for (const resourceTool of ['create_channel', 'write_doc', 'create_task', 'add_memory']) {
    assert.ok(
      byWorkspace.includes(resourceTool),
      `the agw_ control-plane credential must retain ${resourceTool}`,
    );
  }
});

// ---------------------------------------------------------------------------
// The behaviour itself.
// ---------------------------------------------------------------------------
// A REAL signed session token, so the path under test actually executes rather
// than short-circuiting in verifyToken. Without this the assertions below are
// vacuous -- the first draft of this file made exactly that mistake, and the
// workspace SELECT never ran.
async function withRealSession(run) {
  const previous = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'mcp-user-token-test-secret';
  try {
    const db = use([
      { match: /select token_version from app_users where id = \$1/, rows: () => [{ token_version: 1 }] },
      { match: /from workspaces where user_id = \$1/, rows: () => [{ id: WS_OLDEST, mcp_auto_approve: false }] },
    ]);
    const token = await __test.issueToken(USER, '1');
    return await run(token, db);
  } finally {
    if (previous === undefined) delete process.env.AUTH_SECRET;
    else process.env.AUTH_SECRET = previous;
    resetTestState();
  }
}

test('a real signed login token authenticates at the MCP door as kind="user"', async () => {
  await withRealSession(async (token) => {
    const identity = await verifyUserAuthMcpToken(token);
    assert.deepEqual(identity, {
      kind: 'user',
      userId: USER,
      workspaceId: WS_OLDEST,
      name: 'MCP client',
      autoApprove: false,
    }, 'an ordinary session token resolves to a workspace identity carrying the user id');
  });
});

test('an unverifiable bearer does not authenticate', async () => {
  use([{ match: /from workspaces where user_id = \$1/, rows: () => [{ id: WS_OLDEST, mcp_auto_approve: false }] }]);
  assert.equal(await verifyUserAuthMcpToken('not-a-signed-session-token'), null);
});

test('it resolves to the OLDEST owned workspace, not the one the human is using', async () => {
  await withRealSession(async (token, db) => {
    await verifyUserAuthMcpToken(token);
    const call = db.calls.find((c) => /from workspaces where user_id/.test(c.n));
    assert.ok(call, 'the workspace lookup must actually have run -- otherwise this test proves nothing');
    assert.match(
      call.n,
      /order by created_at asc limit 1/,
      'the workspace is chosen by age, so a user who owns several is silently pinned to their first',
    );
    assert.deepEqual(call.params, [USER]);
  });
});

test('the agw_ sibling carries a recognisable prefix; a session token cannot', async () => {
  const { createWorkspaceMcpToken } = __test;
  const minted = createWorkspaceMcpToken();
  assert.match(minted, /^agw_/);

  // This is why redaction cannot be prefix-only. The CLI's redactor (cli/src/
  // render.mjs) also strips the exact resolved credential for this reason.
  const prefixes = /\b(?:aga|agw|agx|agf|agc|ago|cbk)_[A-Za-z0-9_-]+/;
  assert.ok(prefixes.test(minted), 'agw_ is pattern-matchable');
  assert.ok(
    !prefixes.test('dXNlci0x.3.1780000000.c2lnbmF0dXJl'),
    'a session token has no prefix to match, so no log scrubber can recognise it',
  );
});

test('verifyWorkspaceMcpToken is the owner-only, revocable control-plane alternative', async () => {
  use([{ match: /from workspaces where mcp_token_hash = \$1/, rows: () => [{ id: WS_OLDEST, mcp_auto_approve: true }] }]);
  assert.deepEqual(
    await verifyWorkspaceMcpToken('agw_x'),
    { kind: 'workspace', workspaceId: WS_OLDEST, name: 'MCP client', autoApprove: true },
    'the agw_ identity is a workspace principal, not an owner session',
  );

  // Re-minting withdraws this credential without signing any human out.
  // Revoking a user token bumps a per-user counter and signs them out
  // everywhere; that asymmetry is the whole argument for preferring agw_.
  const wsIdentity = await verifyWorkspaceMcpToken('agw_x');
  assert.equal(wsIdentity.userId, undefined);
  assert.equal(wsIdentity.ownerUserId, undefined, 'a workspace principal cannot borrow private-session membership');
  assert.equal(wsIdentity.kind, 'workspace');
});

test('minting the workspace MCP token is an auditable action', () => {
  const { AUDIT_ACTIONS } = require('../shared/backend-core.cjs');
  assert.ok(
    AUDIT_ACTIONS.has('workspace.mcp_token_minted'),
    'minting the workspace control-plane secret must be recordable in the audit log, '
    + 'like its sibling agent.connect_token_minted',
  );
  assert.ok(AUDIT_ACTIONS.has('agent.connect_token_minted'), 'the sibling this mirrors');
});
