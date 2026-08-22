'use strict';

// The credential the LiveKit voice worker uses to reach this workspace's MCP
// tools. It exists because neither existing credential could be used: the
// workspace `agw_` bearer is stored only as a hash (unrecoverable, and minting a
// new one rotates the human's MCP client out of existence), and reusing an
// agent's connect token would rotate a RUNNING daemon's identity to start a call.
//
// What is pinned here is that it grants NOTHING a compromised one could widen:
// it is scoped to a single agent, it expires, it is bound to the workspace it was
// minted for, and it dies the moment the agent is disabled.

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.AUTH_SECRET = process.env.AUTH_SECRET || 'test-secret-for-voice-tokens';

const { __test } = require('../server/index.cjs');
const {
  createVoiceSessionToken,
  verifyVoiceSessionToken,
  VOICE_TOKEN_PREFIX,
  VOICE_TOKEN_MAX_TTL_MS,
} = __test;

const WORKSPACE = '3a9ce2ab-27e7-42db-90fa-7e1ba32cf62e';
const AGENT = '0d212ca9-63ef-4baf-b636-856833ed37e7';

test('a minted voice token is prefixed and carries no readable secret', async () => {
  const token = await createVoiceSessionToken({ workspaceId: WORKSPACE, agentId: AGENT });
  assert.ok(token.startsWith(VOICE_TOKEN_PREFIX), 'the prefix is how the verifier chain routes it');
  // The payload is signed, not encrypted — so it must not carry anything secret.
  const [payload] = token.slice(VOICE_TOKEN_PREFIX.length).split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(claims).sort(), ['a', 'exp', 'w'], 'only workspace, agent and expiry');
  assert.equal(claims.w, WORKSPACE);
  assert.equal(claims.a, AGENT);
});


test('a huddle token is rejected after its huddle ends', async () => {
  let ended = false;
  __test.setTestDb({
    unsafe: async (sql) => {
      if (/from workspace_agents/.test(sql)) return [{
        id: AGENT,
        workspace_id: WORKSPACE,
        name: 'Voice agent',
        enabled: true,
        run_mode: 'builtin',
        permission_mode: 'default',
      }];
      if (/from huddles/.test(sql)) return ended ? [{
        id: 'huddle-1', workspace_id: WORKSPACE, session_id: 'host-1',
        transcript_session_id: 'transcript-session-1', transcript_participants: [AGENT], ended_at: new Date().toISOString(),
      }] : [{
        id: 'huddle-1', workspace_id: WORKSPACE, session_id: 'host-1',
        transcript_session_id: 'transcript-session-1', transcript_participants: [AGENT], ended_at: null,
      }];
      return [];
    },
  });
  const token = await createVoiceSessionToken({
    workspaceId: WORKSPACE, agentId: AGENT, huddleId: 'huddle-1', sessionId: 'transcript-session-1',
  });
  assert.ok(await verifyVoiceSessionToken(token));
  ended = true;
  assert.equal(await verifyVoiceSessionToken(token), null);
});

test('a huddle dispatch token is scoped to that huddle transcript', async () => {
  __test.setTestDb({
    unsafe: async (sql) => /from huddles/.test(sql) ? [{
      id: 'huddle-1', workspace_id: WORKSPACE, session_id: 'host-1',
      transcript_session_id: 'transcript-session-1', transcript_participants: [AGENT], ended_at: null,
    }] : [],
  });
  const token = await createVoiceSessionToken({
    workspaceId: WORKSPACE,
    agentId: AGENT,
    huddleId: 'huddle-1',
    sessionId: 'transcript-session-1',
  });
  const [payload] = token.slice(VOICE_TOKEN_PREFIX.length).split('.');
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  assert.equal(claims.h, 'huddle-1');
  assert.equal(claims.s, 'transcript-session-1');
});

test('minting requires both a workspace and an agent', async () => {
  await assert.rejects(() => createVoiceSessionToken({ workspaceId: WORKSPACE }), /required/);
  await assert.rejects(() => createVoiceSessionToken({ agentId: AGENT }), /required/);
  await assert.rejects(() => createVoiceSessionToken({}), /required/);
});

test('a tampered payload or signature is rejected', async () => {
  const token = await createVoiceSessionToken({ workspaceId: WORKSPACE, agentId: AGENT });
  const [payload, signature] = token.slice(VOICE_TOKEN_PREFIX.length).split('.');

  // Re-point the token at a DIFFERENT agent, keeping the original signature.
  const forged = Buffer.from(JSON.stringify({
    w: WORKSPACE, a: '00000000-0000-0000-0000-000000000000', exp: Date.now() + 60_000,
  })).toString('base64url');
  assert.equal(
    await verifyVoiceSessionToken(`${VOICE_TOKEN_PREFIX}${forged}.${signature}`),
    null,
    'swapping the agent id must not survive the signature check',
  );

  // Flip the signature.
  const flipped = signature.slice(0, -1) + (signature.endsWith('A') ? 'B' : 'A');
  assert.equal(await verifyVoiceSessionToken(`${VOICE_TOKEN_PREFIX}${payload}.${flipped}`), null);

  // Structurally wrong tokens must return null, never throw — this runs on the
  // MCP auth path for EVERY request, including hostile ones.
  for (const bad of ['', 'not-a-token', VOICE_TOKEN_PREFIX, `${VOICE_TOKEN_PREFIX}only-payload`, null, undefined, 42]) {
    assert.equal(await verifyVoiceSessionToken(bad), null, `rejected: ${String(bad)}`);
  }
});

test('an expired token is rejected', async () => {
  // Minimum TTL is clamped to 60s, so an expired one is built directly to prove
  // the expiry branch rather than waiting out a real clock.
  const crypto = require('node:crypto');
  const payload = Buffer.from(JSON.stringify({
    w: WORKSPACE, a: AGENT, exp: Date.now() - 1000,
  })).toString('base64url');
  const signature = crypto.createHmac('sha256', process.env.AUTH_SECRET).update(payload).digest('base64url');
  assert.equal(await verifyVoiceSessionToken(`${VOICE_TOKEN_PREFIX}${payload}.${signature}`), null);
});

test('the TTL ceiling rejects infinite or multi-hour voice credentials', async () => {
  for (const ttlMs of [Infinity, Number.MAX_SAFE_INTEGER]) {
    const before = Date.now();
    const token = await createVoiceSessionToken({ workspaceId: WORKSPACE, agentId: AGENT, ttlMs });
    const [payload] = token.slice(VOICE_TOKEN_PREFIX.length).split('.');
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.ok(exp <= before + VOICE_TOKEN_MAX_TTL_MS + 1000);
  }
});

test('the TTL floor stops a zero or negative lifetime being minted', async () => {
  for (const ttlMs of [0, -1, Number.NaN]) {
    const token = await createVoiceSessionToken({ workspaceId: WORKSPACE, agentId: AGENT, ttlMs });
    const [payload] = token.slice(VOICE_TOKEN_PREFIX.length).split('.');
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    assert.ok(exp > Date.now(), `ttlMs=${ttlMs} must still produce a usable token, not a dead one`);
  }
});
