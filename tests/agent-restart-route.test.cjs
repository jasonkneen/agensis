'use strict';

// POST /backend/agents/:id/restart — tell a linked host to replace its process.
//
// A running daemon has its module graph already loaded, so publishing a new CLI
// changes nothing for it until the process is replaced. Before this the only way
// to adopt a fix was to find the terminal the daemon was launched in by hand.
//
// The property pinned here is AUTHORIZATION. Restarting someone's host is
// disruptive — it is a manage action like disconnect, not a read like
// memory-refresh, and the two sit next to each other in the same file, so the
// wrong one is easy to copy.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(
  path.resolve(__dirname, '../server/agents-routes.cjs'),
  'utf8',
);

function routeBody(routePath) {
  const start = source.indexOf(`app.post('${routePath}'`);
  assert.ok(start > 0, `route ${routePath} is missing`);
  // Far enough to cover the handler, short enough not to swallow the next route.
  const next = source.indexOf('app.post(', start + 10);
  return source.slice(start, next === -1 ? start + 2000 : next);
}

test('the restart route exists and pushes agent_restart to the host', () => {
  const body = routeBody('/backend/agents/:id/restart');
  assert.match(body, /type: 'agent_restart'/, 'the daemon listens for agent_restart');
});

test('restarting a host is manage-gated, not a read', () => {
  const body = routeBody('/backend/agents/:id/restart');
  assert.match(
    body,
    /enforceWorkspaceRole\(req\.userId, agent\.workspace_id, 'manage'\)/,
    "restart must require manage — a reader must not be able to bounce someone's daemon",
  );
  assert.ok(
    !/enforceWorkspaceRole\(req\.userId, agent\.workspace_id, 'read'\)/.test(body),
    'read is the memory-refresh gate; copying it here would under-protect the route',
  );
});

test('every connection for the agent is told, not just the first', () => {
  // A stale host is exactly the one this exists for, so a single findConnectedAgent
  // lookup would leave the others running old code with no way to say so.
  const body = routeBody('/backend/agents/:id/restart');
  assert.match(body, /connectedAgents\.values\(\)/, 'restart fans out over every live connection');
});
