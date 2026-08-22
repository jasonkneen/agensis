'use strict';

// ============================================================================
// tests/task-comment-agent-guard.test.cjs
// ----------------------------------------------------------------------------
// Agent authorship on a task comment must be unforgeable through the generic
// /backend/db write path — the same property document_comments.agent_id has.
//
// Two things break if a browser can set task_comments.agent_id from a generic
// write:
//   * a comment can be made to look like an agent wrote it, and
//   * — because dispatchCommentMentions returns early on any row carrying an
//     agent_id — a comment that @mentions an agent can be posted in a way that
//     silently evades the dispatch.
// A loop guard a client can set is not a guard.
//
// The legitimate agent-authored write (mirrorAgentReplyToTaskComment in the
// server) builds its own insert and never passes through stripPrivilegedDbValues,
// so pinning the column here does not touch it.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PRIVILEGED_DB_COLUMNS_BY_TABLE,
  stripPrivilegedDbValues,
} = require('../shared/backend-core.cjs');

test('task_comments.agent_id is privileged (a client cannot set it)', () => {
  assert.ok(
    PRIVILEGED_DB_COLUMNS_BY_TABLE.task_comments?.has('agent_id'),
    'task_comments.agent_id is missing from PRIVILEGED_DB_COLUMNS_BY_TABLE',
  );
  const stripped = stripPrivilegedDbValues('task_comments', {
    task_id: 't-1',
    content: 'hello',
    agent_id: 'a-1',
  });
  assert.equal(stripped.agent_id, undefined, 'agent_id survived a generic write');
  assert.equal(stripped.task_id, 't-1', 'and the rest of the comment still saves');
});
