'use strict';

// ============================================================================
// tests/mcp-login-token-signal.test.cjs
// ----------------------------------------------------------------------------
// MEASUREMENT, not enforcement. `verifyMcpToken` ends in
// `verifyUserAuthMcpToken`, so a human's ordinary session token authenticates at
// /backend/mcp. Whether it should keep doing so is an open product decision and
// the only missing input is whether anyone uses it, so the door records a
// `mcp.login_token_used` row. Nothing here changes what is allowed.
//
// The whole risk of that idea is VOLUME: MCP auth runs on every request, and the
// audit log is a tamper-evident chain built for rare privileged actions. A row
// per request would bury the actions it exists for. So the two properties worth
// most of this file are:
//
//   * a busy client produces ONE row, not one per call;
//   * the row cannot carry anything that reconstructs a credential.
//
// The stubs cannot fake either. The dedup assertions count rows a real handler
// produced across many real calls, and the redaction assertion runs over the
// whole captured argument object rather than a field the test chose to look at.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { createMcpHandler } = require('../server/mcp.cjs');
const { createFirstUseWindow, AUDIT_ACTIONS, FIRST_USE_WINDOW_MS } = require('../shared/backend-core.cjs');

const WS = 'ws-1';
const USER_TOKEN = 'session-token-for-a-human';
const USER_IDENTITY = { kind: 'user', userId: 'user-1', workspaceId: WS, name: 'MCP client', autoApprove: false };
const OTHER_USER_IDENTITY = { kind: 'user', userId: 'user-2', workspaceId: WS, name: 'MCP client', autoApprove: false };
const AGENT_IDENTITY = { kind: 'agent', agentId: 'agent-1', workspaceId: WS, name: 'Coder', handle: 'coder', agent: {} };
const WORKSPACE_IDENTITY = { kind: 'workspace', workspaceId: WS, name: 'MCP client', autoApprove: false };

function makeRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, ended: false };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (value) => { res.body = value; return res; };
  res.end = () => { res.ended = true; return res; };
  return res;
}

/** A handler wired exactly as index.cjs wires it, with the audit sink captured. */
function makeHandler({ tokenMap, now } = {}) {
  const audits = [];
  const handler = createMcpHandler({
    getDb: () => ({ async unsafe() { return []; } }),
    verifyMcpToken: async (token) => (tokenMap || {
      [USER_TOKEN]: USER_IDENTITY,
      'agent-token': AGENT_IDENTITY,
      'ws-token': WORKSPACE_IDENTITY,
      'other-user-token': OTHER_USER_IDENTITY,
    })[token] || null,
    recordAudit: async (entry) => { audits.push(entry); return { id: `a-${audits.length}` }; },
    ...(now ? { loginTokenWindow: createFirstUseWindow({ now }) } : {}),
    runtimeSchemaReady: Promise.resolve(),
    serverVersion: '9.9.9',
  });
  return { handler, audits };
}

async function call(handler, token, body = { jsonrpc: '2.0', id: 1, method: 'tools/list' }) {
  const res = makeRes();
  await handler({ headers: token ? { authorization: `Bearer ${token}` } : {}, body, url: '/backend/mcp' }, res);
  // The audit write is deliberately not awaited by the handler, so let the
  // microtask queue drain before a test inspects what was recorded.
  await new Promise((resolve) => setImmediate(resolve));
  return res;
}

// ---------------------------------------------------------------------------
// The signal itself.
// ---------------------------------------------------------------------------
test('a login token at the MCP door records one mcp.login_token_used row', async () => {
  const { handler, audits } = makeHandler();
  const res = await call(handler, USER_TOKEN);

  assert.equal(res.statusCode, 200, 'measurement must not change what is allowed');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'mcp.login_token_used');
  assert.equal(audits[0].actor.userId, 'user-1');
  assert.equal(audits[0].workspaceId, WS);
  assert.equal(audits[0].detail.kind, 'user');
  assert.ok(AUDIT_ACTIONS.has('mcp.login_token_used'), 'the action must be in the registry, or it records as "unknown"');
});

test('the recorded row cannot reconstruct the credential', async () => {
  const { handler, audits } = makeHandler();
  await call(handler, USER_TOKEN);

  // Over the WHOLE entry, not a field the test picked -- the same bar the agw_
  // mint row is held to.
  const serialized = JSON.stringify(audits[0]);
  assert.ok(!serialized.includes(USER_TOKEN), 'the token must never reach the row');
  assert.ok(!/aga_|agw_|agx_|agf_|agc_|ago_|cbk_/.test(serialized), 'nor any credential prefix');
  const hash = require('node:crypto').createHash('sha256').update(USER_TOKEN).digest('hex');
  assert.ok(!serialized.includes(hash), 'nor its hash -- a verifier is still a secret');
  assert.deepEqual(Object.keys(audits[0].detail).sort(), ['firstUseInWindowHours', 'kind']);
});

// ---------------------------------------------------------------------------
// Volume. The property that decides whether this belongs in the audit log.
// ---------------------------------------------------------------------------
test('a busy client produces ONE row, not one per request', async () => {
  const { handler, audits } = makeHandler();
  for (let i = 0; i < 200; i += 1) await call(handler, USER_TOKEN);

  assert.equal(audits.length, 1, '200 authenticated requests must leave exactly one row');
});

test('each distinct human is counted separately', async () => {
  const { handler, audits } = makeHandler();
  await call(handler, USER_TOKEN);
  await call(handler, 'other-user-token');
  await call(handler, USER_TOKEN);

  assert.equal(audits.length, 2, 'two people, two rows -- otherwise adoption looks like one retry');
  assert.deepEqual(audits.map((a) => a.actor.userId), ['user-1', 'user-2']);
});

test('the window reopens, so a key seen once a year records once a year', async () => {
  let clock = 1_000_000;
  const { handler, audits } = makeHandler({ now: () => clock });

  await call(handler, USER_TOKEN);
  clock += FIRST_USE_WINDOW_MS - 1000;
  await call(handler, USER_TOKEN);
  assert.equal(audits.length, 1, 'still inside the window');

  clock += 2000;
  await call(handler, USER_TOKEN);
  assert.equal(audits.length, 2, 'the window has passed, so the credential is reported again');
});

// ---------------------------------------------------------------------------
// Scope: only the path with an open question attached.
// ---------------------------------------------------------------------------
test('agent and workspace tokens record nothing', async () => {
  const { handler, audits } = makeHandler();
  for (let i = 0; i < 50; i += 1) {
    await call(handler, 'agent-token');
    await call(handler, 'ws-token');
  }
  assert.equal(audits.length, 0, 'purpose-built MCP credentials have no open question; recording them is noise');
});

// The three guards in noteLoginTokenUse overlap: a real agent identity has no
// userId, so the test above would still pass if the kind check were deleted. The
// next three isolate each guard with an identity built to defeat the other two.
// Verified by mutation -- without these, widening the kind set, dropping the
// userId requirement and removing the sink check all survive.

test('KINDS_TO_RECORD is exactly the login path', () => {
  const { __test } = require('../server/mcp.cjs');
  assert.deepEqual([...__test.KINDS_TO_RECORD], ['user'],
    'widening this records rows for credentials whose use is not in question, '
    + 'and every other kind authenticates on a per-request hot path too');
});

test('a non-user kind is skipped even when it carries a userId', async () => {
  const { handler, audits } = makeHandler({
    tokenMap: { 'hybrid-token': { kind: 'invite', userId: 'user-9', workspaceId: WS, inviteId: 'inv-1', role: 'editor' } },
  });
  await call(handler, 'hybrid-token');
  assert.equal(audits.length, 0, 'the kind set decides, not the presence of a userId');
});

test('a user identity with no userId is skipped rather than bucketed together', async () => {
  // Nothing produces this today -- verifyUserAuthMcpToken always sets userId --
  // but without the guard the window key becomes "user:undefined" and every
  // human on the deploy collapses into a single bucket, which would read as
  // "one person" in exactly the data this exists to produce.
  const { handler, audits } = makeHandler({
    tokenMap: { 'malformed-token': { kind: 'user', workspaceId: WS, name: 'MCP client' } },
  });
  await call(handler, 'malformed-token');
  assert.equal(audits.length, 0);
});

test('with no audit sink the window is left untouched, not silently consumed', async () => {
  // The try/catch would swallow a call to an undefined sink either way, so this
  // pins the guard ORDER: a door with no sink must not burn the credential's
  // once-per-window slot, or the first request after wiring one up records
  // nothing.
  const probed = [];
  const handler = createMcpHandler({
    getDb: () => ({ async unsafe() { return []; } }),
    verifyMcpToken: async () => USER_IDENTITY,
    loginTokenWindow: { shouldRecord: (key) => { probed.push(key); return true; }, size: () => 0 },
    runtimeSchemaReady: Promise.resolve(),
  });
  const res = await call(handler, USER_TOKEN);

  assert.equal(res.statusCode, 200);
  assert.deepEqual(probed, [], 'the sink check must come before the window is consulted');
});

test('an unauthenticated request records nothing', async () => {
  const { handler, audits } = makeHandler();
  const res = await call(handler, null);
  assert.equal(res.statusCode, 401);
  assert.equal(audits.length, 0);
});

test('a door with no audit sink still serves requests', async () => {
  // index.cjs injects recordAudit, but mcp.cjs must not require it -- the
  // measurement is an add-on and its absence cannot break the endpoint.
  const handler = createMcpHandler({
    getDb: () => ({ async unsafe() { return []; } }),
    verifyMcpToken: async () => USER_IDENTITY,
    runtimeSchemaReady: Promise.resolve(),
  });
  const res = await call(handler, USER_TOKEN);
  assert.equal(res.statusCode, 200);
});

test('a failing audit sink cannot fail the request it observes', async () => {
  const handler = createMcpHandler({
    getDb: () => ({ async unsafe() { return []; } }),
    verifyMcpToken: async () => USER_IDENTITY,
    recordAudit: async () => { throw new Error('audit table is down'); },
    runtimeSchemaReady: Promise.resolve(),
  });
  const res = await call(handler, USER_TOKEN);
  assert.equal(res.statusCode, 200, 'the tool call must still succeed');
  assert.ok(res.body?.result, 'and still return its result');
});

// ---------------------------------------------------------------------------
// The window helper on its own.
// ---------------------------------------------------------------------------
test('createFirstUseWindow admits once per key per window', () => {
  let clock = 0;
  const w = createFirstUseWindow({ windowMs: 1000, now: () => clock });

  assert.equal(w.shouldRecord('a'), true);
  assert.equal(w.shouldRecord('a'), false);
  assert.equal(w.shouldRecord('b'), true, 'a different key is independent');

  clock = 1001;
  assert.equal(w.shouldRecord('a'), true, 'the window has expired');
  assert.equal(w.shouldRecord('a'), false);
});

test('createFirstUseWindow is bounded in memory and evicts the oldest first', () => {
  let clock = 0;
  const w = createFirstUseWindow({ windowMs: 100_000, maxKeys: 3, now: () => clock += 1 });

  for (const key of ['a', 'b', 'c']) assert.equal(w.shouldRecord(key), true);
  assert.equal(w.size(), 3);

  assert.equal(w.shouldRecord('d'), true);
  assert.equal(w.size(), 3, 'the map never grows past the cap');
  // 'a' was the oldest insertion, so it is the one that went.
  assert.equal(w.shouldRecord('a'), true, 'evicted, so it records again -- one extra row, never unbounded growth');
  assert.equal(w.shouldRecord('d'), false, 'still inside its window');
});

test('a refreshed key moves to the back of the eviction order', () => {
  let clock = 0;
  const w = createFirstUseWindow({ windowMs: 10, maxKeys: 2, now: () => clock });

  w.shouldRecord('a');
  w.shouldRecord('b');
  clock = 11;
  assert.equal(w.shouldRecord('a'), true, 'a expired and re-recorded');
  // 'a' was just refreshed, so adding a third key must evict 'b', not 'a'.
  w.shouldRecord('c');
  assert.equal(w.size(), 2);
  assert.equal(w.shouldRecord('a'), false, 'a is still tracked -- it was refreshed, not stale');
});

test('createFirstUseWindow ignores an empty key rather than tracking one', () => {
  const w = createFirstUseWindow();
  assert.equal(w.shouldRecord(''), false);
  assert.equal(w.shouldRecord(null), false);
  assert.equal(w.size(), 0);
});
