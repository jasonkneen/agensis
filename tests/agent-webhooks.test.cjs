'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');

const { mountAgentWebhooksRoutes } = require('../server/agent-webhooks-routes.cjs');

async function withWebhookServer(overrides, run) {
  const app = express();
  app.use(express.json());
  const deps = {
    requireAuth(req, _res, next) { req.userId = 'user-1'; next(); },
    jsonError(res, status, error) { return res.status(status).json({ data: null, error: error.message }); },
    async enforceWorkspaceRole() {},
    getDb() { return { unsafe: async () => [] }; },
    notifyDbSubscribers() {},
    broadcastGlobal() { return 0; },
    clientIpFromReq() { return '127.0.0.1'; },
    async continueConversation() {},
    hashAgentToken(value) { return `hash:${value}`; },
    inviteTokenLookupParams(value) { return [`hash:${value}`, value]; },
    rateLimitBlocked() { return false; },
    slugHandle(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '-'); },
    verifyNetlifyDeploySignature() { return true; },
    webhookRateLimiter: {},
    ...overrides,
  };
  mountAgentWebhooksRoutes(app, deps);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

test('generic webhook creation stores only a token hash and returns the token once', async () => {
  const notifications = [];
  const calls = [];
  await withWebhookServer({
    async enforceWorkspaceRole(userId, workspaceId, role) {
      assert.deepEqual([userId, workspaceId, role], ['user-1', 'workspace-1', 'manage']);
    },
    getDb() {
      return {
        async unsafe(sql, params) {
          calls.push([String(sql), params]);
          if (String(sql).includes('select id from workspace_agents')) return [{ id: 'agent-1' }];
          if (String(sql).includes('insert into agent_webhooks')) {
            assert.match(params[3], /^hash:/);
            return [{ id: 'hook-1', workspace_id: params[0], agent_id: params[1], name: params[2], token: params[3] }];
          }
          return [];
        },
      };
    },
    notifyDbSubscribers(table, event, rows) { notifications.push([table, event, rows]); },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/agent-webhooks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_id: 'workspace-1', agent_id: 'agent-1', name: 'Build hook' }),
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.data.id, 'hook-1');
    assert.equal(body.data.token.startsWith('hash:'), false);
  });
  assert.equal(calls.length, 2);
  assert.equal(notifications.length, 1);
  assert.deepEqual(notifications[0].slice(0, 2), ['agent_webhooks', 'INSERT']);
});

test('a generic webhook starts a normal mentioned conversation and reports the accepted message', async () => {
  const notifications = [];
  const continuations = [];
  await withWebhookServer({
    getDb() {
      return {
        async unsafe(sql, params) {
          const query = String(sql);
          if (query.includes('from agent_webhooks w')) {
            assert.deepEqual(params, ['hash:public-token', 'public-token']);
            return [{
              id: 'hook-1', workspace_id: 'workspace-1', name: 'Build hook',
              agent_row_id: 'agent-1', agent_name: 'Builder', agent_handle: 'builder',
              agent_enabled: true, model: 'auto',
            }];
          }
          if (query.includes('insert into chat_sessions')) return [{ id: 'session-1', workspace_id: params[0] }];
          if (query.includes('insert into messages')) {
            assert.equal(params[0], 'session-1');
            assert.equal(params[1], '@builder fix the failing build');
            return [{ id: 'message-1', session_id: params[0], content: params[1] }];
          }
          if (query.includes('update agent_webhooks set last_triggered_at')) return [{ id: 'hook-1' }];
          throw new Error(`Unexpected query: ${query}`);
        },
      };
    },
    notifyDbSubscribers(table, event) { notifications.push([table, event]); },
    async continueConversation(value) { continuations.push(value); },
  }, async baseUrl => {
    const response = await fetch(`${baseUrl}/backend/webhooks/public-token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'fix the failing build' }),
    });
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      data: { sessionId: 'session-1', messageId: 'message-1' },
      error: null,
    });
  });
  assert.deepEqual(continuations, [{ workspaceId: 'workspace-1', sessionId: 'session-1' }]);
  assert.deepEqual(notifications, [
    ['chat_sessions', 'INSERT'],
    ['messages', 'INSERT'],
    ['agent_webhooks', 'UPDATE'],
  ]);
});

test('generic webhook trigger refuses unknown, unassigned, disabled, and rate-limited calls', async () => {
  let lookupResult = [];
  let dbCalls = 0;
  let blocked = false;
  await withWebhookServer({
    rateLimitBlocked(res) {
      if (!blocked) return false;
      res.status(429).json({ data: null, error: 'Too many requests' });
      return true;
    },
    getDb() {
      return {
        async unsafe(sql) {
          dbCalls += 1;
          if (String(sql).includes('from agent_webhooks w')) {
            assert.match(String(sql), /w\.enabled = true/);
            return lookupResult;
          }
          throw new Error('A refused webhook must not write');
        },
      };
    },
  }, async baseUrl => {
    const post = token => fetch(`${baseUrl}/backend/webhooks/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'run' }),
    });

    assert.equal((await post('unknown')).status, 404);
    lookupResult = [{ id: 'hook-1', workspace_id: 'w', agent_row_id: null, agent_enabled: true }];
    assert.equal((await post('unassigned')).status, 409);
    lookupResult = [{ id: 'hook-1', workspace_id: 'w', agent_row_id: 'a', agent_enabled: false }];
    assert.equal((await post('disabled-agent')).status, 409);
    blocked = true;
    const callsBeforeBlock = dbCalls;
    assert.equal((await post('limited')).status, 429);
    assert.equal(dbCalls, callsBeforeBlock);
  });
});
