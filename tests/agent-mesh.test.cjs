'use strict';

// Regression coverage for the agent-mesh direct-handoff plumbing (agent-mesh F1-F8):
// advertising reach over the drift channel, redacting it from browsers, and the
// hub-minted peer-auth ticket format. No DB / live sockets required — these pin the
// pure decision points; the WebSocket wiring itself is exercised manually against a
// live workspace (see cascade/agent-mesh/20-plan.cf for the full protocol).

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const { reachFromMessage, reachIsDirect, publicAgentConnection, mintPeerTicket } = __test;

test('reachFromMessage sanitizes and caps an incoming reach advert', () => {
  const sanitized = reachFromMessage({
    listening: true,
    addrs: [
      { host: '192.168.1.5', port: 4123, scope: 'lan' },
      { host: '10.0.0.2', port: 4124, scope: 'lan' },
      { host: 'a', port: 1, scope: 'lan' },
      { host: 'b', port: 2, scope: 'lan' },
      { host: 'c', port: 3, scope: 'lan' }, // dropped: cap is 4
    ],
  });
  assert.equal(sanitized.transport, 'ws');
  assert.equal(sanitized.listening, true);
  assert.equal(sanitized.auth, 'hub-pairwise');
  assert.equal(sanitized.addrs.length, 4);
  assert.deepEqual(sanitized.addrs[0], { host: '192.168.1.5', port: 4123, scope: 'lan' });
});

test('reachFromMessage normalizes a bad scope and rejects non-numeric ports', () => {
  const sanitized = reachFromMessage({ listening: true, addrs: [{ host: 'x', port: 'nope', scope: 'wan' }] });
  assert.equal(sanitized.addrs[0].scope, 'other');
  assert.equal(sanitized.addrs[0].port, 0);
});

test('reachFromMessage returns undefined for absent/malformed reach (older daemons)', () => {
  assert.equal(reachFromMessage(undefined), undefined);
  assert.equal(reachFromMessage(null), undefined);
  assert.equal(reachFromMessage('nope'), undefined);
});

test('reachFromMessage defaults listening to false and addrs to [] when omitted', () => {
  const sanitized = reachFromMessage({});
  assert.equal(sanitized.listening, false);
  assert.deepEqual(sanitized.addrs, []);
});

test('reachIsDirect requires listening:true and at least one addr', () => {
  assert.equal(reachIsDirect({ reach: { listening: true, addrs: [{ host: 'a', port: 1 }] } }), true);
  assert.equal(reachIsDirect({ reach: { listening: true, addrs: [] } }), false);
  assert.equal(reachIsDirect({ reach: { listening: false, addrs: [{ host: 'a', port: 1 }] } }), false);
  assert.equal(reachIsDirect({}), false);
  assert.equal(reachIsDirect(null), false);
});

test('publicAgentConnection strips reach before a row ever reaches a browser', () => {
  const row = {
    id: 'conn-1',
    workspace_id: 'ws-1',
    agent_id: 'agent-1',
    name: 'Scout',
    handle: 'scout',
    host: 'jasons-mac',
    cwd: '/repo',
    status: 'online',
    metadata: '{}',
    capabilities: JSON.stringify({
      skills: ['a'],
      clis: [],
      mcpServers: [],
      reach: { transport: 'ws', listening: true, addrs: [{ host: '192.168.1.5', port: 4123, scope: 'lan' }], auth: 'hub-pairwise' },
    }),
    connected_at: null,
    last_seen_at: null,
    updated_at: null,
  };
  const publicRow = publicAgentConnection(row);
  assert.equal(publicRow.capabilities.reach, undefined);
  assert.deepEqual(publicRow.capabilities.skills, ['a']);
  assert.equal('reach' in publicRow.capabilities, false);
});

test('publicAgentConnection is a no-op passthrough on a null/undefined row', () => {
  assert.equal(publicAgentConnection(null), null);
  assert.equal(publicAgentConnection(undefined), undefined);
});

test('mintPeerTicket produces unique agp_-prefixed single-use ticket ids', () => {
  const a = mintPeerTicket();
  const b = mintPeerTicket();
  assert.match(a, /^agp_[A-Za-z0-9_-]+$/);
  assert.notEqual(a, b);
});
