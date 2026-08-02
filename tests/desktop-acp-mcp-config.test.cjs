'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAgensisMcpServers } = require('../electron/acp/mcpConfig.cjs');

test('buildAgensisMcpServers returns authenticated HTTP MCP entry', () => {
  const servers = buildAgensisMcpServers({
    baseUrl: 'https://agensis-backend.fly.dev',
    token: 'aga_testtoken',
  });
  assert.equal(servers.length, 1);
  assert.equal(servers[0].type, 'http');
  assert.equal(servers[0].name, 'agensis');
  assert.equal(servers[0].url, 'https://agensis-backend.fly.dev/backend/mcp');
  assert.deepEqual(servers[0].headers, [
    { name: 'Authorization', value: 'Bearer aga_testtoken' },
  ]);
});

test('buildAgensisMcpServers rewrites Vite loopback to local Fly port', () => {
  const servers = buildAgensisMcpServers({
    baseUrl: 'http://127.0.0.1:5173',
    token: 'aga_x',
  });
  assert.equal(servers[0].url, 'http://127.0.0.1:3142/backend/mcp');
});

test('buildAgensisMcpServers empty without token or base', () => {
  assert.deepEqual(buildAgensisMcpServers({}), []);
  assert.deepEqual(buildAgensisMcpServers({ baseUrl: 'https://agensis-backend.fly.dev' }), []);
  assert.deepEqual(buildAgensisMcpServers({ token: 'aga_x' }), []);
});
