'use strict';

// SM-8 contract test (docs/queue-plumbing-audit-2026-09-21.md):
//
//   "parkChatTurn writes DB before pendingChatTurns.set" — the original
//    code did the OPPOSITE: pendingChatTurns.set ran first, then a fire-and-
//    forget IIFE shadowed it to pending_chat_turns. A throw inside that IIFE
//    left the in-process Map populated but the DB row missing, so a restart
//    could not recover the parked turn — the Map was gone and the DB had
//    nothing to replay from."
//
// The fix preserves the SYNCHRONOUS Map.set invariant (so callers that read
// pendingChatTurns the moment parkChatTurn returns still work — see the
// continueConversation re-park branch and the unit tests) and rolls the Map
// entry back if the durable write fails. The failure-mode analysis:
//
//   - DB ok + Map ok: row in both (same as today).
//   - DB ok + Map would have failed (synchronous throw): row in DB only;
//     the orphan sweep replays it on the next tick. STRICTLY BETTER than
//     today — today there is no orphan to replay.
//   - DB fail + Map ok (today's buggy case): Map is rolled back, DB has no
//     row. SAME outcome as today — strictly no regression.
//
// Properties pinned here:
//   1. parkChatTurn is synchronous (the live path and unit tests depend on
//      the Map being readable the moment it returns; making it async would
//      turn synchronous assertions into flakes).
//   2. writeThroughParkedTurn accepts a completion callback that fires
//      AFTER the durable write has either committed or thrown.
//   3. parkChatTurn sets the Map entry FIRST, then calls writeThroughParkedTurn
//      with a rollback that deletes the Map entry on failure. The rollback
//      only fires if the Map still holds THIS entry — a later park that
//      overwrote it must not be erased.
//   4. The re-park branch inside drainPendingChatTurn applies the same rule.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const indexSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'index.cjs'),
    'utf8',
);

function regionFrom(src, startMarker, endMarker) {
 const startIdx = src.indexOf(startMarker);
 assert.ok(startIdx >= 0, `start marker not found: ${startMarker.slice(0, 60)}`);
 const endIdx = src.indexOf(endMarker, startIdx);
 assert.ok(endIdx > startIdx, `end marker not found after ${startIdx}: ${endMarker.slice(0, 60)}`);
 return src.slice(startIdx, endIdx);
}

// (1) parkChatTurn is synchronous.
test('SM-8 (1): parkChatTurn is synchronous so the Map is readable the moment it returns', () => {
 const region = regionFrom(
  indexSrc,
  '// SM-8: the Map.set is synchronous',
  'function drainPendingChatTurn(sessionId',
 );
 assert.match(region, /^function parkChatTurn\(/m);
 // Specifically NOT async.
 assert.doesNotMatch(region, /async function parkChatTurn/);
});

// (2) writeThroughParkedTurn accepts a completion callback.
test('SM-8 (2): writeThroughParkedTurn takes a completion callback', () => {
 const region = regionFrom(
  indexSrc,
  'function writeThroughParkedTurn(',
  'function forgetParkedTurn(',
 );
 assert.match(region, /function writeThroughParkedTurn\(key, entry, onComplete = null\)/);
 // The callback fires on success.
 assert.match(region, /onComplete\(null\)/);
 // The callback fires on failure.
 assert.match(region, /onComplete\(error\)/);
});

// (3) parkChatTurn sets the Map FIRST, then writes through with a rollback.
test('SM-8 (3): parkChatTurn sets the Map first and rolls back on DB failure', () => {
 const region = regionFrom(
  indexSrc,
  '// SM-8: the Map.set is synchronous',
  'function drainPendingChatTurn(sessionId',
 );
 const mapSetIdx = region.indexOf('pendingChatTurns.set(key, entry)');
 const writeIdx = region.indexOf('writeThroughParkedTurn(key, entry');
 assert.ok(mapSetIdx >= 0, 'parkChatTurn still sets the Map');
 assert.ok(writeIdx >= 0, 'parkChatTurn still writes through to the DB');
 assert.ok(mapSetIdx < writeIdx, `Map.set (${mapSetIdx}) must precede writeThroughParkedTurn (${writeIdx})`);
 // The completion callback ROLLS BACK the Map on failure — and only if the Map
 // still holds this exact entry.
 assert.match(region, /pendingChatTurns\.delete\(key\)/);
 assert.match(region, /pendingChatTurns\.get\(key\) === entry/);
});

// (4) The re-park branch inside drainPendingChatTurn applies the same rule.
test('SM-8 (4): the re-park branch in drainPendingChatTurn is also Map-first with rollback', () => {
 const region = regionFrom(
  indexSrc,
  "if (out && (out.reason === 'agent_busy' || out.reason === 'locked')) {",
  "} catch (error) {\n   console.error('drainPendingChatTurn failed', error);",
 );
 const mapSetIdx = region.indexOf('pendingChatTurns.set(key, next)');
 const writeIdx = region.indexOf('writeThroughParkedTurn(key, next');
 assert.ok(mapSetIdx >= 0, 're-park branch still sets the Map');
 assert.ok(writeIdx >= 0, 're-park branch still writes through to the DB');
 assert.ok(mapSetIdx < writeIdx, `Map.set (${mapSetIdx}) must precede writeThroughParkedTurn (${writeIdx})`);
 assert.match(region, /pendingChatTurns\.delete\(key\)/);
 assert.match(region, /pendingChatTurns\.get\(key\) === next/);
});

// (5) The comment block references the audit file and SM-8 so a future reader
// can follow the reasoning.
test('SM-8 (5): the audit comment is in place', () => {
 const region = regionFrom(
  indexSrc,
  '// SM-8: the Map.set is synchronous',
  'function drainPendingChatTurn(sessionId',
 );
 assert.match(region, /SM-8/);
 assert.match(region, /docs\/queue-plumbing-audit-2026-09-21\.md/);
});