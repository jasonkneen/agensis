// ============================================================================
// tests/capture-backlink-survives-dispatch.test.cjs
// ----------------------------------------------------------------------------
// A task CAPTURED from a conversation (server/chat-task-capture.cjs) stores the
// channel the human actually asked in as source_id. Dispatch used to overwrite
// that with the agent's DM id, because 'chat' is in
// TASK_SOURCE_LINK_OVERWRITABLE and a captured task is 'chat' too.
//
// Observed once, immediately, on the first capture ever made: "Can we check
// queued messages…" was linked to #testtest (7ba4f0d6) at 18:09:46, dispatched
// at 18:19:45, and its back-link silently became the Coder DM (54436004). The
// only record of where the request came from was gone, and "Open chat" landed
// in a DM that never mentions it.
//
// origin_job_id is the discriminator: server-owned, and it means exactly "this
// provenance was written by the capture sweep".
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { createTaskDispatch } = require('../server/task-dispatch.cjs');

const { dispatchMayStampSourceLink } = createTaskDispatch({});

const CHANNEL = '7ba4f0d6-9140-48a3-b7de-510d61cdf244'; // #testtest
const JOB = '9a124069-17a9-44cc-91f0-43e9a6c6e6b2';

test('a captured task keeps its channel back-link through dispatch', () => {
  // The exact production row, before dispatch touched it.
  const captured = { source_type: 'chat', source_id: CHANNEL, origin_job_id: JOB };
  assert.equal(dispatchMayStampSourceLink(captured), false);
});

test('an ordinary chat task still re-points at the current DM', () => {
  // The behaviour that put 'chat' in the overwritable set in the first place:
  // a task dispatched twice should offer the CURRENT conversation.
  assert.equal(dispatchMayStampSourceLink({ source_type: 'chat', source_id: 'old-dm', origin_job_id: null }), true);
  assert.equal(dispatchMayStampSourceLink({ source_type: 'manual', source_id: null }), true);
  assert.equal(dispatchMayStampSourceLink({ source_type: '', source_id: null }), true);
  assert.equal(dispatchMayStampSourceLink({}), true);
});

test('real provenance is still protected, captured or not', () => {
  // Unchanged from before: source_id means something different for these, so
  // dispatch never claims the pair.
  for (const source_type of ['ai', 'canvas', 'document', 'feedback', 'automation']) {
    assert.equal(dispatchMayStampSourceLink({ source_type }), false, source_type);
    assert.equal(dispatchMayStampSourceLink({ source_type, origin_job_id: JOB }), false, source_type);
  }
});

test('both dispatch paths use the shared rule, and both read the column', () => {
  const root = path.join(__dirname, '..');
  const dispatch = fs.readFileSync(path.join(root, 'server', 'task-dispatch.cjs'), 'utf8');
  const index = fs.readFileSync(path.join(root, 'server', 'index.cjs'), 'utf8');

  // Neither site may call the raw Set any more — that is the bug.
  assert.doesNotMatch(dispatch, /const stampSource = TASK_SOURCE_LINK_OVERWRITABLE\.has/);
  assert.doesNotMatch(index, /const stampSource = TASK_SOURCE_LINK_OVERWRITABLE\.has/);
  assert.match(dispatch, /const stampSource = dispatchMayStampSourceLink\(task\)/);
  assert.match(index, /const stampSource = dispatchMayStampSourceLink\(task\)/);

  // A rule that reads a column the SELECT never fetched is always true, which
  // would look exactly like a fix and change nothing. Both selects must ask.
  const dispatchSelect = dispatch.slice(dispatch.indexOf('select id, workspace_id, title, description, status'));
  assert.match(dispatchSelect.slice(0, 240), /origin_job_id/);
  const mentionSelect = index.slice(index.indexOf("'select id, status, source_type, source_id"));
  assert.match(mentionSelect.slice(0, 120), /origin_job_id/);
});
