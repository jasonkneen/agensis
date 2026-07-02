'use strict';

// Regression coverage for the heartbeat capability/memory drift-check.
//
// The daemon owns two hashes (capabilitiesHash, memoryHash) and sends them on every
// heartbeat. The server is a dumb comparator: it compares the heartbeat hashes against
// the last values it stored on a real snapshot and nudges a full re-push on a mismatch.
// These tests pin the pure decision (capabilitiesDriftNudges) and the "format we need"
// shape gate (capabilitiesShapeValid) — no DB required.

const test = require('node:test');
const assert = require('node:assert/strict');

const { __test } = require('../server/index.cjs');
const { capabilitiesDriftNudges, capabilitiesShapeValid } = __test;

const validStored = {
  skills: ['a', 'b'],
  clis: ['claude'],
  mcpServers: ['agensis'],
  memoryRoot: '/root',
  hash: 'CAP1',
  memoryHash: 'MEM1',
};

test('no nudge when both hashes match the stored reference', () => {
  const nudges = capabilitiesDriftNudges(validStored, { capabilitiesHash: 'CAP1', memoryHash: 'MEM1' });
  assert.deepEqual(nudges, []);
});

test('capabilities drift nudges only a capabilities refresh', () => {
  const nudges = capabilitiesDriftNudges(validStored, { capabilitiesHash: 'CAP2', memoryHash: 'MEM1' });
  assert.deepEqual(nudges, ['agent_capabilities_refresh']);
});

test('memory drift nudges only a memory refresh', () => {
  const nudges = capabilitiesDriftNudges(validStored, { capabilitiesHash: 'CAP1', memoryHash: 'MEM2' });
  assert.deepEqual(nudges, ['agent_memory_refresh']);
});

test('both drifting nudges both refreshes', () => {
  const nudges = capabilitiesDriftNudges(validStored, { capabilitiesHash: 'X', memoryHash: 'Y' });
  assert.deepEqual(nudges, ['agent_capabilities_refresh', 'agent_memory_refresh']);
});

test('older daemon sending no hashes is never nudged (no storm)', () => {
  assert.deepEqual(capabilitiesDriftNudges(validStored, {}), []);
  assert.deepEqual(capabilitiesDriftNudges({}, {}), []);
  // Even a malformed stored row must not be nudged when the daemon sent no hash to act on.
  assert.deepEqual(capabilitiesDriftNudges(null, {}), []);
});

test('malformed / never-synced stored capabilities self-heal on a hashed beat', () => {
  // Default '{}' row (agent connected, snapshot not yet landed): a hashed beat forces a resync.
  assert.deepEqual(capabilitiesDriftNudges({}, { capabilitiesHash: 'CAP1' }), ['agent_capabilities_refresh']);
  assert.deepEqual(capabilitiesDriftNudges(null, { capabilitiesHash: 'CAP1' }), ['agent_capabilities_refresh']);
  // Wrong shape (skills not an array) is treated as drift regardless of hash equality.
  const bad = { skills: 'nope', clis: [], mcpServers: [], hash: 'CAP1' };
  assert.deepEqual(capabilitiesDriftNudges(bad, { capabilitiesHash: 'CAP1' }), ['agent_capabilities_refresh']);
});

test('capabilitiesShapeValid enforces the format we need', () => {
  assert.equal(capabilitiesShapeValid(validStored), true);
  assert.equal(capabilitiesShapeValid({ skills: [], clis: [], mcpServers: [], memoryRoot: null }), true);
  assert.equal(capabilitiesShapeValid({}), false);
  assert.equal(capabilitiesShapeValid(null), false);
  assert.equal(capabilitiesShapeValid({ skills: [], clis: [], mcpServers: [], memoryRoot: 5 }), false);
  assert.equal(capabilitiesShapeValid({ skills: {}, clis: [], mcpServers: [] }), false);
});
