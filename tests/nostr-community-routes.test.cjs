'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { mountNostrCommunityRoutes } = require('../server/nostr-community-routes.cjs');

test('Nostr community routes require auth and enforce workspace and session scopes', async () => {
  const checks = [];
  const calls = [];
  const app = express();
  app.use(express.json());
  const requireAuth = (req, res, next) => {
    if (req.headers.authorization !== 'Bearer test') return res.status(401).json({ error: { message: 'Unauthorized' } });
    req.userId = 'user-1';
    next();
  };
  const enforceWorkspaceRole = async (userId, workspaceId, role) => {
    checks.push({ kind: 'workspace', userId, workspaceId, role });
    if (workspaceId === 'other-workspace') throw Object.assign(new Error('Forbidden'), { status: 403 });
  };
  const enforceSessionRead = async (userId, sessionId) => {
    checks.push({ kind: 'session', userId, sessionId });
  };
  const connection = { id: 'connection-1', workspace_id: 'workspace-1' };
  const nostrCommunities = {
    async previewInvite() { return { host: 'community.test', name: 'Community', supportedNips: [29, 42] }; },
    async connectCommunity(input) { calls.push(['connect', input]); return { connection, channels: [], alreadyConnected: false }; },
    async listConnections(workspaceId) { calls.push(['list', workspaceId]); return [connection]; },
    async connectionById() { return connection; },
    async discoverChannels() { calls.push(['channels']); return []; },
    async mapChannels(_id, mappings) { calls.push(['map', mappings]); return [{}]; },
    async membersForSession(sessionId) { calls.push(['members', sessionId]); return []; },
    async disconnectCommunity() { calls.push(['disconnect']); return connection; },
  };
  mountNostrCommunityRoutes(app, {
    requireAuth,
    jsonError: (res, status, error) => res.status(status).json({ error: { message: error.message } }),
    enforceWorkspaceRole,
    enforceSessionRead,
    getDb: () => ({ unsafe: async () => [{ id: 'session-1', workspace_id: 'workspace-1' }] }),
    nostrCommunities,
  });

  await withServer(app, async baseUrl => {
    const unauthorized = await fetch(`${baseUrl}/backend/nostr-communities/preview`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ inviteUrl: 'https://community.test/invite/x' }),
    });
    assert.equal(unauthorized.status, 401);

    const auth = { authorization: 'Bearer test', 'content-type': 'application/json' };
    const preview = await fetch(`${baseUrl}/backend/nostr-communities/preview`, {
      method: 'POST', headers: auth, body: JSON.stringify({ inviteUrl: 'https://community.test/invite/x' }),
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal('code' in previewBody.data, false);
    assert.equal('inviteUrl' in previewBody.data, false);

    assert.equal((await fetch(`${baseUrl}/backend/workspaces/workspace-1/nostr-communities`, {
      method: 'POST', headers: auth, body: JSON.stringify({ inviteUrl: 'https://community.test/invite/x' }),
    })).status, 201);
    assert.equal((await fetch(`${baseUrl}/backend/workspaces/workspace-1/nostr-communities`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${baseUrl}/backend/workspaces/other-workspace/nostr-communities`, { headers: auth })).status, 403);
    assert.equal((await fetch(`${baseUrl}/backend/nostr-communities/connection-1/channels`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${baseUrl}/backend/nostr-communities/connection-1/channels`, {
      method: 'POST', headers: auth, body: JSON.stringify({ mappings: [{ channelId: 'c1', sessionId: 'session-1' }] }),
    })).status, 201);
    assert.equal((await fetch(`${baseUrl}/backend/sessions/session-1/nostr-members`, { headers: auth })).status, 200);
    assert.equal((await fetch(`${baseUrl}/backend/nostr-communities/connection-1`, { method: 'DELETE', headers: auth })).status, 200);
  });

  assert.ok(checks.some(value => value.kind === 'workspace' && value.role === 'manage'));
  assert.ok(checks.some(value => value.kind === 'workspace' && value.role === 'read'));
  assert.ok(checks.some(value => value.kind === 'session' && value.sessionId === 'session-1'));
  assert.ok(calls.some(value => value[0] === 'connect'));
  assert.ok(calls.some(value => value[0] === 'map'));
  assert.ok(calls.some(value => value[0] === 'disconnect'));
});

function withServer(app, run) {
  const server = http.createServer(app);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      try {
        const address = server.address();
        await run(`http://127.0.0.1:${address.port}`);
        server.close(error => error ? reject(error) : resolve());
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}
