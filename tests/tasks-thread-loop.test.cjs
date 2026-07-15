// ============================================================================
// tests/tasks-thread-loop.test.cjs
// ----------------------------------------------------------------------------
// Tasks <-> subthread <-> comments loop (2026-07): when a human @mentions an
// agent on a task, the dispatch lands in a per-task SUBTHREAD of the agent's DM
// (not the main timeline), the task is assigned + moved in_progress, and the
// agent's subthread reply is MIRRORED BACK as a task comment. Guarantees:
//   1. taskStatusOnDispatch bumps 'todo' -> 'in_progress' and never clobbers a
//      terminal/started status.
//   2. shouldMirrorAgentMessage only fires for a real agent reply inside a
//      subthread (not humans, not the "Thinking" placeholder, not the main DM).
//   3. postTaskSubthreadMention creates ONE stable per-task root and appends
//      later mentions under it (so a task's conversation stays in one thread).
//   4. mirrorAgentReplyToTaskComment turns a subthread reply whose root is tied
//      to a task into an agent-authored task_comment; unrelated replies no-op.
// ============================================================================

const test = require('node:test');
const assert = require('node:assert/strict');
const { __test } = require('../server/index.cjs');

test.afterEach(() => __test.resetTestState());

// --- (1) status transition on dispatch -------------------------------------

test('taskStatusOnDispatch moves a fresh task into progress', () => {
  assert.equal(__test.taskStatusOnDispatch('todo'), 'in_progress');
});

test('taskStatusOnDispatch never clobbers a started or terminal status', () => {
  assert.equal(__test.taskStatusOnDispatch('in_progress'), 'in_progress');
  assert.equal(__test.taskStatusOnDispatch('done'), 'done');
  assert.equal(__test.taskStatusOnDispatch('cancelled'), 'cancelled');
  assert.equal(__test.taskStatusOnDispatch(''), '');
  assert.equal(__test.taskStatusOnDispatch(null), null);
});

// --- (2) mirror-eligibility decision ---------------------------------------

test('shouldMirrorAgentMessage fires for a real agent reply in a subthread', () => {
  assert.equal(
    __test.shouldMirrorAgentMessage({ sender_kind: 'agent', thread_parent_id: 'root-1', content: 'Done, shipped.' }),
    true,
  );
});

test('shouldMirrorAgentMessage rejects humans, the main DM, and placeholders', () => {
  // a human comment
  assert.equal(__test.shouldMirrorAgentMessage({ sender_kind: 'user', thread_parent_id: 'root-1', content: 'hi' }), false);
  // an agent reply on the MAIN timeline (no subthread) — not a task thread
  assert.equal(__test.shouldMirrorAgentMessage({ sender_kind: 'agent', thread_parent_id: null, content: 'hi' }), false);
  // the streaming placeholder must never mirror
  assert.equal(__test.shouldMirrorAgentMessage({ sender_kind: 'agent', thread_parent_id: 'root-1', content: 'Thinking 0s' }), false);
  assert.equal(__test.shouldMirrorAgentMessage({ sender_kind: 'agent', thread_parent_id: 'root-1', content: '   ' }), false);
});

// --- (3) per-task subthread routing ----------------------------------------

function messagesDb({ existingRoot = null, onInsert } = {}) {
  let seq = 0;
  return {
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select id from messages where session_id')) {
        return existingRoot ? [{ id: existingRoot }] : [];
      }
      if (n.startsWith('insert into messages')) {
        seq += 1;
        const row = { id: `m-${seq}`, sql: n, params };
        if (onInsert) onInsert(row);
        return [row];
      }
      return [];
    },
  };
}

test('postTaskSubthreadMention opens a new per-task root when none exists', async () => {
  let inserted = null;
  __test.setTestDb(messagesDb({ existingRoot: null, onInsert: (r) => { inserted = r; } }));

  const out = await __test.postTaskSubthreadMention({
    session: { id: 's1' },
    taskId: 't-42',
    content: '@coder do it',
    authorUserId: 'u1',
    authorName: 'Jason',
  });

  // the newly-created root message IS the thread parent for the agent's replies
  assert.equal(out.threadParentId, inserted.id, 'thread parent is the new root message');
  assert.ok(inserted.sql.includes('source_task_id'), 'root is tagged with its source task');
  assert.ok(!inserted.sql.includes('thread_parent_id'), 'a root message has no thread parent');
  assert.ok(inserted.params.includes('t-42'), 'the task id is persisted on the root');
});

test('postTaskSubthreadMention appends under the existing per-task root', async () => {
  let inserted = null;
  __test.setTestDb(messagesDb({ existingRoot: 'root-existing', onInsert: (r) => { inserted = r; } }));

  const out = await __test.postTaskSubthreadMention({
    session: { id: 's1' },
    taskId: 't-42',
    content: '@coder follow-up',
    authorUserId: 'u1',
    authorName: 'Jason',
  });

  assert.equal(out.threadParentId, 'root-existing', 'reuses the stable per-task thread');
  assert.ok(inserted.sql.includes('thread_parent_id'), 'the follow-up is a reply under the root');
  assert.ok(inserted.params.includes('root-existing'), 'reply points at the existing root');
});

// --- (4) mirror an agent subthread reply back to task comments --------------

function mirrorDb({ sourceTaskId = null, taskWorkspace = 'w1', onCommentInsert } = {}) {
  return {
    async unsafe(sql, params) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('select source_task_id from messages where id')) {
        return [{ source_task_id: sourceTaskId }];
      }
      if (n.startsWith('select workspace_id from tasks where id')) {
        return [{ workspace_id: taskWorkspace }];
      }
      if (n.startsWith('insert into task_comments')) {
        const row = { id: 'c-1', sql: n, params };
        if (onCommentInsert) onCommentInsert(row);
        return [row];
      }
      return [];
    },
  };
}

test('mirrorAgentReplyToTaskComment posts an agent-authored comment on the source task', async () => {
  let comment = null;
  __test.setTestDb(mirrorDb({ sourceTaskId: 't-42', taskWorkspace: 'w1', onCommentInsert: (c) => { comment = c; } }));

  const out = await __test.mirrorAgentReplyToTaskComment({
    sender_kind: 'agent',
    sender_id: 'a-coder',
    thread_parent_id: 'root-existing',
    content: 'Fixed and verified.',
  });

  assert.ok(out, 'a comment row is returned');
  assert.ok(comment, 'a task_comments insert happened');
  assert.ok(comment.params.includes('t-42'), 'comment is attached to the source task');
  assert.ok(comment.params.includes('a-coder'), 'comment is attributed to the agent');
  assert.ok(comment.params.includes('Fixed and verified.'), 'the reply text is carried across');
});

test('mirrorAgentReplyToTaskComment no-ops for a subthread not tied to a task', async () => {
  let comment = null;
  __test.setTestDb(mirrorDb({ sourceTaskId: null, onCommentInsert: (c) => { comment = c; } }));

  const out = await __test.mirrorAgentReplyToTaskComment({
    sender_kind: 'agent',
    sender_id: 'a-coder',
    thread_parent_id: 'root-plain-dm',
    content: 'just a normal DM reply',
  });

  assert.equal(out, null, 'no comment created');
  assert.equal(comment, null, 'no task_comments insert issued');
});

test('mirrorAgentReplyToTaskComment ignores human and placeholder messages', async () => {
  let comment = null;
  __test.setTestDb(mirrorDb({ sourceTaskId: 't-42', onCommentInsert: (c) => { comment = c; } }));

  assert.equal(
    await __test.mirrorAgentReplyToTaskComment({ sender_kind: 'user', thread_parent_id: 'root-existing', content: 'hi' }),
    null,
  );
  assert.equal(
    await __test.mirrorAgentReplyToTaskComment({ sender_kind: 'agent', thread_parent_id: 'root-existing', content: 'Thinking 3s' }),
    null,
  );
  assert.equal(comment, null, 'neither path inserts a comment');
});
