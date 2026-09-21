'use strict';

// Contract test for the MCP tool kind restriction added when
// `force_drain_agent_queue` and `get_agent_queue_status` were introduced.
//
// Both tools audit a `agent.queue_force_drained` row that carries the
// operator's user id, and that audit row is durable. An agent identity should
// not be able to force-drain another agent's queue, nor read another agent's
// last-drain audit row, so the MCP tool surface rejects 'agent' kinds — both
// at the kinds-list layer (which the MCP transport enforces) and at the run()
// layer (which catches a relayed tool call that bypasses the kinds list).
//
// Properties:
//   1. force_drain_agent_queue's kinds list is exactly ['workspace', 'user'].
//   2. get_agent_queue_status's kinds list is exactly ['workspace', 'user'].
//   3. Both tools explicitly throw on identity.kind === 'agent' as a
//      belt-and-braces guard for relayed calls.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const mcpSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'mcp.cjs'),
    'utf8',
);

function regionFrom(src, startMarker, endMarker) {
 const startIdx = src.indexOf(startMarker);
 assert.ok(startIdx >= 0, `start marker not found: ${startMarker.slice(0, 60)}`);
 const endIdx = src.indexOf(endMarker, startIdx);
 assert.ok(endIdx > startIdx, `end marker not found after ${startIdx}: ${endMarker.slice(0, 60)}`);
 return src.slice(startIdx, endIdx);
}

test('MCP: force_drain_agent_queue kinds list is workspace,user only', () => {
 const region = regionFrom(
  mcpSrc,
  'add({\n  name: \'force_drain_agent_queue\',',
  'add({\n  name: \'get_agent_queue_status\',',
 );
 // The kinds list must NOT include 'agent'.
 assert.match(region, /kinds: \['workspace', 'user'\]/);
 assert.doesNotMatch(region, /kinds: \['workspace', 'user', 'agent'\]/);
});

test('MCP: force_drain_agent_queue run() throws if identity.kind === agent', () => {
 const region = regionFrom(
  mcpSrc,
  'add({\n  name: \'force_drain_agent_queue\',',
  'add({\n  name: \'get_agent_queue_status\',',
 );
 assert.match(region, /if \(identity && identity\.kind === 'agent'\) \{/);
 assert.match(region, /force_drain_agent_queue requires workspace or user authority/);
});

test('MCP: get_agent_queue_status kinds list is workspace,user only', () => {
 const region = regionFrom(
  mcpSrc,
  'add({\n  name: \'get_agent_queue_status\',',
  'return tools;\n}',
 );
 assert.match(region, /kinds: \['workspace', 'user'\]/);
 assert.doesNotMatch(region, /kinds: \['workspace', 'user', 'agent'\]/);
});

test('MCP: get_agent_queue_status run() throws if identity.kind === agent', () => {
 const region = regionFrom(
  mcpSrc,
  'add({\n  name: \'get_agent_queue_status\',',
  'return tools;\n}',
 );
 assert.match(region, /if \(identity && identity\.kind === 'agent'\) \{/);
 assert.match(region, /get_agent_queue_status requires workspace or user authority/);
});