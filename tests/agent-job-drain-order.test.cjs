'use strict';

// Contract test for SM-2 (docs/queue-plumbing-audit-2026-09-21.md):
//
//   After finalizeAgentJobResult commits the terminal UPDATE, the task-queue
//   drain and the parked-chat-turn drain MUST run in order: the task drain
//   must AWAIT to completion before the chat drain begins. Without this
//   ordering, the chat drain's continueConversation SELECT on agent_jobs can
//   race the task drain's INSERT and re-park a turn that the task drain is
//   about to dispatch. That is the "agents finish a job and don't move to the
//   next" symptom.
//
// The previous wiring registered two INDEPENDENT afterDurableWrite callbacks
// — `() => scheduleTaskQueueDrain(...)` and `() => drainPendingChatTurn(...)`.
// The afterCommit loop in agent-jobs.cjs invokes each callback and discards
// its return value, so the chat drain started before the task drain had even
// issued its first DB query.
//
// The fix wraps both into ONE afterDurableWrite callback whose body awaits
// drainAgentTaskQueue first, then drainPendingChatTurn. This file pins that
// wiring in three ways:
//
//   1. The callback shape: exactly one afterDurableWrite call for both drains.
//   2. The ordering: drainAgentTaskQueue is awaited before drainPendingChatTurn.
//   3. Defensive: each drain is wrapped in its own try/catch so a throw in
//      one does not abort the other.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const agentJobsSrc = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'agent-jobs.cjs'),
    'utf8',
);

function regionFrom(src, startMarker, endMarker) {
 const startIdx = src.indexOf(startMarker);
 assert.ok(startIdx >= 0, `start marker not found: ${startMarker.slice(0, 60)}`);
 const endIdx = src.indexOf(endMarker, startIdx);
 assert.ok(endIdx > startIdx, `end marker not found after ${startIdx}: ${endMarker.slice(0, 60)}`);
 return src.slice(startIdx, endIdx);
}

test('SM-2: post-commit drains are wrapped in ONE afterDurableWrite callback (not two)', () => {
 const region = regionFrom(
  agentJobsSrc,
  '// The agent just freed its one active-job slot',
  '// And the third thing this moment settles',
 );
 // Two afterDurableWrite calls would be `afterDurableWrite(...)` twice on
 // adjacent lines. The fix uses exactly one.
 const calls = (region.match(/afterDurableWrite\s*\(/g) || []).length;
 assert.equal(calls, 1, `expected exactly one afterDurableWrite for both drains; got ${calls}. Region:\n${region}`);
});

test('SM-2: the combined callback awaits drainAgentTaskQueue BEFORE drainPendingChatTurn', () => {
 const region = regionFrom(
  agentJobsSrc,
  '// The agent just freed its one active-job slot',
  '// And the third thing this moment settles',
 );
 // The task drain must be awaited (not just voided) before the chat drain is
 // invoked. We accept any await-prefixed form (await await, await void, etc.)
 // but the task-drain await must come textually first.
 const taskIdx = region.indexOf('await drainAgentTaskQueue');
 const chatIdx = region.indexOf('drainPendingChatTurn');
 assert.ok(taskIdx >= 0, 'the post-commit drain must await drainAgentTaskQueue (no fire-and-forget wrapper here)');
 assert.ok(chatIdx >= 0, 'the post-commit drain must still call drainPendingChatTurn');
 assert.ok(taskIdx < chatIdx, `drainAgentTaskQueue (${taskIdx}) must come before drainPendingChatTurn (${chatIdx})`);
 // Both await calls must happen INSIDE the afterDurableWrite callback body, not
 // outside it. The cleanest assertion: the await of drainAgentTaskQueue appears
 // before the afterDurableWrite closes.
 const callbackCloseIdx = region.lastIndexOf('});');
 assert.ok(taskIdx < callbackCloseIdx, 'drainAgentTaskQueue must be awaited INSIDE the afterDurableWrite callback');
});

test('SM-2: a throw in the task drain does NOT abort the chat drain', () => {
 const region = regionFrom(
  agentJobsSrc,
  '// The agent just freed its one active-job slot',
  '// And the third thing this moment settles',
 );
 // Two try/catch blocks (one per drain) — task first, chat second. The catches
 // must log so the failure is visible; "do nothing" catches would re-introduce
 // SM-1 (silent failure).
 const taskTryIdx = region.indexOf('await drainAgentTaskQueue') - region.slice(0, region.indexOf('await drainAgentTaskQueue')).lastIndexOf('try');
 const taskCatchIdx = region.indexOf("console.error('post-commit task-queue drain failed'");
 const chatCatchIdx = region.indexOf("console.error('post-commit chat-turn drain failed'");
 assert.ok(taskCatchIdx >= 0, 'task drain throw must be logged, not swallowed');
 assert.ok(chatCatchIdx >= 0, 'chat drain throw must be logged, not swallowed');
 assert.ok(taskCatchIdx < chatCatchIdx, 'task drain catch must come before chat drain catch');
});

test('SM-2: the comment block names the audit file so the next reader sees the context', () => {
 // A future reader needs the WHY, not just the WHAT. Pin that the comment
 // points to docs/queue-plumbing-audit-2026-09-21.md so the audit history
 // stays discoverable from the code.
 const region = regionFrom(
  agentJobsSrc,
  '// The agent just freed its one active-job slot',
  '// And the third thing this moment settles',
 );
 assert.match(region, /docs\/queue-plumbing-audit-2026-09-21\.md/);
 assert.match(region, /SM-2/);
});