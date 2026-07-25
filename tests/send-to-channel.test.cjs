// ============================================================================
// tests/send-to-channel.test.cjs
// ----------------------------------------------------------------------------
// "Send to channel" (2026-07): an agent WORKS in a thread and only broadcasts its
// answer. Before this, the "Thinking …" placeholder sat in the CHANNEL and quietly
// turned into the final answer, with every tool chip threaded under it — so the
// channel carried the whole working session for one answer.
//
// The invariants pinned here:
//   1. resolveWorkThreadParent picks the NEWEST top-level human message (the seed
//      of this burst) and degrades to "no work thread" when there isn't one, so a
//      session with nothing to hang a thread off behaves exactly as before.
//   2. A channel turn's placeholder is created INSIDE that thread, and the job
//      carries workThreadParentId + broadcastToChannel while metadata.threadParentId
//      stays at the DISPATCH level (null) so continueConversation keeps resuming
//      where the human is talking.
//   3. finalizeAgentJobResult flags the final answer broadcast_to_channel — and
//      only the final answer. Intermediate segments and tool chips stay unflagged,
//      i.e. stay in the thread.
//   4. NO REGRESSION on what shipped the same day:
//      - tool steps still resolve the placeholder's thread ROOT, so they are
//        SIBLINGS of the reply inside the work thread (not buried a level deeper);
//      - segment rotation still finalises + reopens inside that same thread, and a
//        turn ending on a segment still leaves no orphan placeholder — with the
//        surviving block being the row that gets broadcast.
//   5. The channel-level context load is "top level OR broadcast", not top level
//      only — otherwise buildAgentTurnContext forgets every answer and
//      continueConversation counts zero agent turns and re-dispatches forever.
//   6. sanitizeRealtimeRow does not strip broadcast_to_channel from the messages
//      fanout (the blank-column trap: a flag the client never receives is a flag
//      that never moves a message into the channel view).
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { __test } = require('../server/index.cjs');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const WORKSPACE_ID = 'ws-1';
const SESSION_ID = 'session-1';
const AGENT = { id: 'agent-1', name: 'Coder', handle: 'coder', run_mode: 'daemon', model: 'auto', enabled: true };
const AUTH = { agentId: 'agent-1', workspaceId: 'ws-1', name: 'Coder', handle: 'coder' };

function humanMessage(overrides = {}) {
  return {
    id: 'msg-human',
    session_id: SESSION_ID,
    role: 'user',
    content: '@coder what does channelView do?',
    thread_parent_id: null,
    sender_kind: 'user',
    sender_id: 'user-1',
    sender_name: 'Jason',
    broadcast_to_channel: false,
    created_at: '2026-07-25T10:00:00.000Z',
    ...overrides,
  };
}

// A fake pg that KEEPS what it is told to write, so a test can assert on the end
// state of the conversation (which rows exist, where they sit, which are flagged)
// rather than only on the SQL that flew past. Jobs are mutated in place so a
// segment's metadata write is visible to the next segment and to the result.
function installDb({ messages = [humanMessage()] } = {}) {
  const calls = [];
  const store = new Map(messages.map((row) => [row.id, { ...row }]));
  const jobs = new Map();
  let autoId = 0;
  const nextId = (prefix) => `${prefix}-${++autoId}`;

  const db = {
    calls,
    store,
    jobs,
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });

      // --- context loads (loadChannelMessages) --------------------------------
      if (n.startsWith('select id, role, content, sender_kind, sender_id, sender_name, message_kind, tool_name, tool_detail, broadcast_to_channel, created_at')) {
        const threadScoped = n.includes('(id = $2 or thread_parent_id = $2)');
        const rows = [...store.values()].filter((row) => row.session_id === params[0] && !row.deleted_at);
        const scoped = threadScoped
          ? rows.filter((row) => row.id === params[1] || row.thread_parent_id === params[1])
          // The channel level is "top level OR broadcast to the channel".
          : rows.filter((row) => !row.thread_parent_id || row.broadcast_to_channel);
        return scoped.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }

      // --- resolveWorkThreadParent ------------------------------------------
      if (n.startsWith("select id from messages where session_id = $1 and thread_parent_id is null and role = 'user'")) {
        const rows = [...store.values()]
          .filter((row) => row.session_id === params[0] && !row.thread_parent_id && row.role === 'user' && !row.deleted_at)
          .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
        return rows.length > 0 ? [{ id: rows[0].id }] : [];
      }

      // --- message writes ----------------------------------------------------
      if (n.startsWith('insert into messages (id, session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name)')) {
        const row = {
          id: params[0],
          session_id: params[1],
          role: 'assistant',
          content: n.includes("'assistant', 'Thinking 0s'") ? 'Thinking 0s' : params[2],
          thread_parent_id: params[3] ?? null,
          sender_kind: 'agent',
          sender_id: params[4],
          sender_name: params[5],
          broadcast_to_channel: false,
          created_at: new Date().toISOString(),
        };
        // The placeholder insert binds (id, session, parent, sender, name) — five
        // params, because 'Thinking 0s' is inline in the SQL.
        if (n.includes("'assistant', 'Thinking 0s'")) {
          row.thread_parent_id = params[2] ?? null;
          row.sender_id = params[3];
          row.sender_name = params[4];
        }
        store.set(row.id, row);
        return [{ ...row }];
      }
      if (n.startsWith('insert into messages (session_id, role, content, thread_parent_id, sender_kind, sender_id, sender_name')) {
        const isStep = n.includes('message_kind, tool_name, tool_detail');
        const row = {
          id: nextId('msg'),
          session_id: params[0],
          role: 'assistant',
          content: params[1],
          thread_parent_id: params[2] ?? null,
          sender_kind: 'agent',
          sender_id: params[3],
          sender_name: params[4],
          message_kind: isStep ? 'tool_step' : '',
          tool_name: isStep ? params[5] : '',
          tool_detail: isStep ? params[6] : '',
          broadcast_to_channel: isStep ? false : Boolean(params[5]),
          created_at: new Date().toISOString(),
        };
        store.set(row.id, row);
        return [{ ...row }];
      }
      if (n.startsWith("update messages set content = $2, sender_kind = 'agent', sender_id = $3, sender_name = $4")) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[4]) return [];
        row.content = params[1];
        row.sender_kind = 'agent';
        row.sender_id = params[2];
        row.sender_name = params[3];
        if (params.length > 5) row.broadcast_to_channel = Boolean(params[5]);
        return [{ ...row }];
      }
      if (n.startsWith('update messages set broadcast_to_channel = true')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[1]) return [];
        row.broadcast_to_channel = true;
        return [{ ...row }];
      }
      if (n.startsWith('update messages set content = $2, broadcast_to_channel = $4')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[2]) return [];
        if (n.includes("content ~ '^Thinking '") && !/^Thinking /.test(String(row.content))) return [];
        row.content = params[1];
        row.broadcast_to_channel = Boolean(params[3]);
        return [{ ...row }];
      }
      if (n.startsWith('select thread_parent_id from messages where id = $1 and session_id = $2')) {
        const row = store.get(params[0]);
        return row && row.session_id === params[1] ? [{ thread_parent_id: row.thread_parent_id }] : [];
      }
      if (n.startsWith('select * from messages where id = $1 and session_id = $2')) {
        const row = store.get(params[0]);
        return row && row.session_id === params[1] ? [{ ...row }] : [];
      }
      if (n.startsWith('delete from messages where id = $1 and session_id = $2')) {
        const row = store.get(params[0]);
        if (!row || row.session_id !== params[1]) return [];
        store.delete(params[0]);
        return [{ ...row }];
      }

      // --- job reads/writes --------------------------------------------------
      if (n.startsWith('select j.*, a.name as agent_name')) {
        // Mirror the real WHERE clause: a mismatched agent or workspace matches nothing.
        const job = jobs.get(params[0]);
        if (!job || job.agent_id !== params[1] || job.workspace_id !== params[2]) return [];
        return [{ ...job }];
      }
      if (n.startsWith('insert into agent_jobs')) {
        const metadata = params[params.length - 1];
        const job = {
          id: nextId('job'),
          workspace_id: params[0],
          agent_id: params[1],
          connection_id: n.includes('connection_id') ? params[2] : null,
          session_id: SESSION_ID,
          status: n.includes("'queued'") ? 'queued' : 'running',
          agent_name: AGENT.name,
          agent_handle: AGENT.handle,
          metadata,
        };
        jobs.set(job.id, job);
        return [{ ...job }];
      }
      if (n.startsWith('update agent_jobs set updated_at = now(), metadata = $2::jsonb')) {
        const job = jobs.get(params[0]);
        if (!job || !['queued', 'running'].includes(job.status)) return [];
        job.metadata = params[1];
        return [{ id: job.id }];
      }
      if (n.startsWith('update agent_jobs set status = $2, response = $3, error = $4')) {
        const job = jobs.get(params[0]);
        if (!job) return [];
        job.status = params[1];
        return [{ ...job }];
      }
      // finalizeStuckJob's own guard-and-fail write.
      if (n.startsWith("update agent_jobs set status = 'error', error = $2")) {
        const job = jobs.get(params[0]);
        if (!job || !['queued', 'running'].includes(job.status)) return [];
        job.status = 'error';
        return [{ id: job.id }];
      }

      // Everything else (heartbeat, activity log, task mirror, queue drain,
      // continueConversation's session load) resolves empty and no-ops.
      return [];
    },
  };
  __test.setTestDb(db);
  return db;
}

/** The rows the CHANNEL view would show: top level plus broadcast thread replies. */
function channelView(db) {
  return [...db.store.values()]
    .filter((row) => !row.thread_parent_id || row.broadcast_to_channel)
    .map((row) => row.content);
}

/** The rows the THREAD panel would show for one root. */
function threadView(db, rootId) {
  return [...db.store.values()]
    .filter((row) => row.thread_parent_id === rootId)
    .map((row) => row.content);
}

function connectDaemon() {
  const sent = [];
  const ws = { readyState: 1, agentConnectionId: 'conn-1', send: (value) => sent.push(JSON.parse(value)) };
  __test.registerTestConnectedAgent({
    connectionId: 'conn-1',
    workspaceId: WORKSPACE_ID,
    agentId: AGENT.id,
    handle: AGENT.handle,
    name: AGENT.name,
    ws,
  });
  return { ws, sent };
}

function agentWs() {
  return { agentAuth: AUTH, agentConnectionId: 'conn-1' };
}

function onlyJob(db) {
  const list = [...db.jobs.values()];
  assert.equal(list.length, 1, 'exactly one job per turn');
  return list[0];
}

test.afterEach(() => __test.resetTestState());

// --- (1) where the work thread comes from -----------------------------------

test('resolveWorkThreadParent picks the newest top-level human message', async () => {
  installDb({
    messages: [
      humanMessage({ id: 'msg-old', created_at: '2026-07-25T09:00:00.000Z' }),
      humanMessage({ id: 'msg-new', created_at: '2026-07-25T10:00:00.000Z' }),
      // An agent's own broadcast answer is not a seed, and neither is a reply.
      humanMessage({ id: 'msg-answer', role: 'assistant', sender_kind: 'agent', created_at: '2026-07-25T10:01:00.000Z' }),
      humanMessage({ id: 'msg-in-thread', thread_parent_id: 'msg-new', created_at: '2026-07-25T10:02:00.000Z' }),
    ],
  });

  assert.deepEqual(await __test.resolveWorkThreadParent(SESSION_ID), { parentId: 'msg-new', broadcast: true });
});

test('resolveWorkThreadParent degrades to no work thread when there is no seed', async () => {
  installDb({ messages: [] });
  assert.deepEqual(await __test.resolveWorkThreadParent(SESSION_ID), { parentId: null, broadcast: false });
});

test('resolveWorkThreadParent ignores a soft-deleted seed', async () => {
  installDb({ messages: [humanMessage({ deleted_at: '2026-07-25T10:05:00.000Z' })] });
  assert.deepEqual(await __test.resolveWorkThreadParent(SESSION_ID), { parentId: null, broadcast: false });
});

// --- (2) the channel turn works in the thread -------------------------------

test('a channel turn puts its placeholder inside the thread on the human message', async () => {
  const db = installDb();
  const { sent } = connectDaemon();

  const result = await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  assert.deepEqual(result, { ok: true, pending: true });

  const placeholder = [...db.store.values()].find((row) => /^Thinking /.test(String(row.content)));
  assert.ok(placeholder, 'the turn opened a placeholder');
  assert.equal(placeholder.thread_parent_id, 'msg-human', 'it works in the thread, not the channel');
  assert.equal(placeholder.broadcast_to_channel, false, 'a placeholder is never broadcast');

  // While it works, the channel shows ONLY the human's message. That is the
  // accepted tradeoff — deliberately no channel-level "working…" row.
  assert.deepEqual(channelView(db), ['@coder what does channelView do?']);

  const job = onlyJob(db);
  assert.equal(job.metadata.workThreadParentId, 'msg-human');
  assert.equal(job.metadata.broadcastToChannel, true);
  assert.equal(job.metadata.threadParentId, null, 'the DISPATCH level stays the channel, so the loop resumes there');
  assert.equal(job.metadata.responseMessageId, placeholder.id);
  assert.equal(typeof job.metadata, 'object', 'metadata is bound as an object, never JSON.stringify');
  assert.equal(sent.length, 1, 'the daemon was handed the job');
});

test('a turn already inside a thread keeps working there and broadcasts nothing', async () => {
  const db = installDb({
    messages: [humanMessage(), humanMessage({ id: 'msg-reply', thread_parent_id: 'msg-human', created_at: '2026-07-25T10:01:00.000Z' })],
  });
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID, threadParentId: 'msg-human' });

  const placeholder = [...db.store.values()].find((row) => /^Thinking /.test(String(row.content)));
  assert.equal(placeholder.thread_parent_id, 'msg-human');
  const job = onlyJob(db);
  assert.equal(job.metadata.broadcastToChannel, false, 'a thread reply has nothing to broadcast out of');
  assert.equal(job.metadata.threadParentId, 'msg-human');
});

test('a session with no human seed falls back to the pre-feature top-level behaviour', async () => {
  const db = installDb({ messages: [] });
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });

  const placeholder = [...db.store.values()].find((row) => /^Thinking /.test(String(row.content)));
  assert.equal(placeholder.thread_parent_id, null, 'nothing to hang a thread off — work at the top level');
  assert.equal(onlyJob(db).metadata.broadcastToChannel, false);
});

// --- (3) only the final answer is broadcast ---------------------------------

test('the final answer is broadcast and shows in BOTH the channel and the thread', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const job = onlyJob(db);
  await __test.finalizeAgentJobResult(job, { responseText: 'It filters the channel transcript.' });

  const answer = db.store.get(job.metadata.responseMessageId);
  assert.equal(answer.content, 'It filters the channel transcript.');
  assert.equal(answer.broadcast_to_channel, true, 'the answer graduates into the channel');
  assert.equal(answer.thread_parent_id, 'msg-human', 'and stays a thread message — it is in both views');

  assert.deepEqual(channelView(db), ['@coder what does channelView do?', 'It filters the channel transcript.']);
  assert.deepEqual(threadView(db, 'msg-human'), ['It filters the channel transcript.']);
});

test('a failed turn broadcasts the failure rather than going silent in the channel', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  await __test.finalizeAgentJobResult(onlyJob(db), { errorText: 'the daemon crashed' });

  assert.deepEqual(channelView(db), ['@coder what does channelView do?', '@coder failed: the daemon crashed']);
});

test('a wedged turn broadcasts its stopped-responding notice', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const job = onlyJob(db);
  await __test.finalizeStuckJob(job, 'timed out');

  const notice = db.store.get(job.metadata.responseMessageId);
  assert.match(notice.content, /^@coder stopped responding \(timed out\)/);
  assert.equal(notice.broadcast_to_channel, true, 'silence in the channel would read as "still thinking" forever');
});

test('a turn with no daemon connected broadcasts the "no daemon" notice', async () => {
  const db = installDb();

  const result = await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  assert.deepEqual(result, { ok: false, pending: false });

  const notice = [...db.store.values()].find((row) => row.sender_kind === 'agent');
  assert.match(notice.content, /no daemon is connected/);
  assert.equal(notice.thread_parent_id, 'msg-human', 'it is still written in the work thread');
  assert.equal(notice.broadcast_to_channel, true, 'but the human has to see it');
});

// --- (4) no regression: tool steps ------------------------------------------

test('tool steps land as SIBLINGS of the reply inside the work thread', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const job = onlyJob(db);

  await __test.handleAgentJobStep(agentWs(), { jobId: job.id, kind: 'tool', name: 'Read', detail: 'src/App.tsx' });
  await __test.handleAgentJobStep(agentWs(), { jobId: job.id, kind: 'tool', name: 'Bash', detail: 'npm test' });

  const steps = [...db.store.values()].filter((row) => row.message_kind === 'tool_step');
  assert.equal(steps.length, 2);
  for (const step of steps) {
    assert.equal(step.thread_parent_id, 'msg-human', 'a step sits beside the reply, not under it — one level, so the thread panel renders it');
    assert.equal(step.broadcast_to_channel, false, 'a chip is working detail, never channel content');
  }
  const placeholder = db.store.get(job.metadata.responseMessageId);
  assert.equal(placeholder.thread_parent_id, 'msg-human', 'steps and the reply are siblings in the SAME thread');

  // The channel is still just the human's message while the agent works.
  assert.deepEqual(channelView(db), ['@coder what does channelView do?']);
  assert.deepEqual(threadView(db, 'msg-human').length, 3, 'placeholder + two chips, all visible in the thread');
});

// --- (4) no regression: segmented turns -------------------------------------

test('segment rotation happens inside the work thread', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const job = onlyJob(db);
  const firstPlaceholderId = job.metadata.responseMessageId;

  await __test.handleAgentJobSegment(agentWs(), { jobId: job.id, text: 'Reading the filter first.', elapsedMs: 100 });

  const block = db.store.get(firstPlaceholderId);
  assert.equal(block.content, 'Reading the filter first.');
  assert.equal(block.thread_parent_id, 'msg-human');
  assert.equal(block.broadcast_to_channel, false, 'an intermediate block stays in the thread');

  const fresh = db.store.get(job.metadata.responseMessageId);
  assert.notEqual(fresh.id, firstPlaceholderId, 'a NEW placeholder took its place');
  assert.match(String(fresh.content), /^Thinking \d/);
  assert.equal(fresh.thread_parent_id, 'msg-human', 'the replacement sits where the message it succeeds sat');

  assert.deepEqual(channelView(db), ['@coder what does channelView do?'], 'the channel is still quiet mid-turn');
});

test('a segmented turn ending on a block broadcasts that block and leaves no orphan', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const job = onlyJob(db);

  await __test.handleAgentJobSegment(agentWs(), { jobId: job.id, text: 'Reading the filter first.', elapsedMs: 100 });
  await __test.handleAgentJobSegment(agentWs(), { jobId: job.id, text: 'Done — it is top level OR broadcast.', elapsedMs: 900 });
  // The daemon's final result repeats the last block; it must not be posted twice.
  await __test.finalizeAgentJobResult(job, { responseText: 'Done — it is top level OR broadcast.' });

  const contents = [...db.store.values()].map((row) => row.content);
  assert.ok(!contents.some((content) => /^Thinking /.test(String(content))), 'the spent placeholder was removed');
  assert.deepEqual(
    channelView(db),
    ['@coder what does channelView do?', 'Done — it is top level OR broadcast.'],
    'the surviving block IS the answer, so it is what gets broadcast',
  );
  assert.deepEqual(
    threadView(db, 'msg-human'),
    ['Reading the filter first.', 'Done — it is top level OR broadcast.'],
    'the thread keeps the whole working conversation',
  );
});

test('a segmented turn whose tail streamed on broadcasts only the tail', async () => {
  const db = installDb();
  connectDaemon();

  await __test.runAgentTurn(AGENT, { workspaceId: WORKSPACE_ID, sessionId: SESSION_ID });
  const job = onlyJob(db);

  await __test.handleAgentJobSegment(agentWs(), { jobId: job.id, text: 'Reading the filter first.', elapsedMs: 100 });
  await __test.finalizeAgentJobResult(job, { responseText: 'Everything compiles.' });

  assert.deepEqual(channelView(db), ['@coder what does channelView do?', 'Everything compiles.']);
  assert.deepEqual(threadView(db, 'msg-human'), ['Reading the filter first.', 'Everything compiles.']);
});

// --- (5) the channel-level context load -------------------------------------

test('the channel-level context load includes broadcast thread replies', async () => {
  const db = installDb({
    messages: [
      humanMessage(),
      // the agent's answer: a thread reply, broadcast
      humanMessage({
        id: 'msg-answer',
        role: 'assistant',
        sender_kind: 'agent',
        sender_id: AGENT.id,
        sender_name: AGENT.name,
        content: 'It filters the channel transcript.',
        thread_parent_id: 'msg-human',
        broadcast_to_channel: true,
        created_at: '2026-07-25T10:01:00.000Z',
      }),
      // working detail: a thread reply, NOT broadcast
      humanMessage({
        id: 'msg-step',
        role: 'assistant',
        sender_kind: 'agent',
        content: 'Read · src/App.tsx',
        thread_parent_id: 'msg-human',
        message_kind: 'tool_step',
        broadcast_to_channel: false,
        created_at: '2026-07-25T10:00:30.000Z',
      }),
    ],
  });

  const rows = await __test.loadChannelMessages(SESSION_ID);
  assert.deepEqual(
    rows.map((row) => row.id),
    ['msg-human', 'msg-answer'],
    'the answer is in the channel context; the tool chip is not',
  );

  const load = db.calls.find((c) => c.n.includes('from messages where session_id = $1 and (thread_parent_id is null'));
  assert.ok(load, 'the channel-level load is the OR predicate, not top-level-only');
  assert.match(load.n, /\(thread_parent_id is null or broadcast_to_channel\)/);
  assert.match(load.n, /select id, role, content, .*broadcast_to_channel, created_at/);
});

test('the thread-level context load still scopes to one thread', async () => {
  installDb({
    messages: [
      humanMessage(),
      humanMessage({ id: 'msg-reply', content: 'in the thread', thread_parent_id: 'msg-human', created_at: '2026-07-25T10:01:00.000Z' }),
      humanMessage({ id: 'msg-elsewhere', content: 'another channel message', created_at: '2026-07-25T10:02:00.000Z' }),
    ],
  });

  const rows = await __test.loadChannelMessages(SESSION_ID, 'msg-human');
  assert.deepEqual(rows.map((row) => row.id), ['msg-human', 'msg-reply']);
});

// --- (6) the blank-column trap ----------------------------------------------

const DDL = /ALTER TABLE messages ADD COLUMN IF NOT EXISTS broadcast_to_channel boolean NOT NULL DEFAULT false/;

test('broadcast_to_channel exists in all three schema places', () => {
  // 1. Runtime bootstrap — what runs on Fly boot, so the only one that reaches an
  //    already-provisioned production DB.
  assert.match(read('server/index.cjs'), DDL, 'ensureRuntimeSchema is missing messages.broadcast_to_channel');
  // 2. Canonical schema — what `npm run db:neon:push` applies to a fresh DB.
  assert.match(read('database/neon-schema.sql'), DDL, 'neon-schema.sql is missing messages.broadcast_to_channel');
  // 3. Migration — what a DB provisioned from supabase/migrations alone gets.
  const migrations = fs.readdirSync(path.join(root, 'supabase/migrations'))
    .filter((name) => name.endsWith('_message_broadcast_to_channel.sql'));
  assert.equal(migrations.length, 1, 'expected exactly one message_broadcast_to_channel migration');
  assert.match(read(path.join('supabase/migrations', migrations[0])), DDL, 'the migration is missing messages.broadcast_to_channel');
});

test('broadcast_to_channel defaults false so every pre-existing row stays valid and stays in the channel', () => {
  // NOT NULL with DEFAULT false is safe on a populated table; NOT NULL with no
  // default would reject every existing row, and a nullable column would make the
  // channel filter depend on three-valued logic.
  for (const file of ['server/index.cjs', 'database/neon-schema.sql']) {
    const line = new RegExp('broadcast_to_channel boolean NOT NULL DEFAULT false').exec(read(file));
    assert.ok(line, `${file} must declare broadcast_to_channel NOT NULL DEFAULT false`);
  }
});

/** Every `select <columns> from messages` list in a source file, whitespace-normalized. */
function messageSelectLists(source) {
  const flat = source.replace(/\s+/g, ' ');
  const pattern = /select\s+((?:(?!\bfrom\b).)*?)\s+from\s+messages\b/gi;
  const lists = [];
  let match;
  while ((match = pattern.exec(flat)) !== null) lists.push(match[1].trim());
  return lists;
}

test('every explicit message column list that selects sender_kind also selects broadcast_to_channel', () => {
  // A column a query does not name comes back undefined, so ONE un-updated
  // explicit list is enough to make a broadcast reply look unflagged — and vanish
  // from the channel view — while every other path looks fine.
  const lists = messageSelectLists(read('server/index.cjs'));
  assert.ok(lists.length > 0, 'no `select ... from messages` statements found — the scanner is broken');
  const explicit = lists.filter((list) => /\bsender_kind\b/.test(list));
  assert.ok(explicit.length > 0, 'expected at least one explicit message column list naming sender_kind');
  for (const list of explicit) {
    assert.ok(
      /\bbroadcast_to_channel\b/.test(list),
      `message column list omits broadcast_to_channel (it would load blank): select ${list} from messages`,
    );
  }
});

test('the realtime fanout does not strip broadcast_to_channel', () => {
  // The flag arriving late is the same as it never arriving: the answer would sit
  // in the thread and never appear in the channel until a reload.
  const sent = [];
  __test.registerTestWebsocketClient({
    userId: 'user-1',
    readyState: 1,
    subscriptions: [{ type: 'db_changes', schema: 'public', table: 'messages', event: '*' }],
    send: (str) => sent.push(JSON.parse(str)),
  });

  __test.notifyDbSubscribers('messages', 'UPDATE', [{
    id: 'msg-answer',
    session_id: SESSION_ID,
    workspace_id: WORKSPACE_ID,
    role: 'assistant',
    sender_kind: 'agent',
    sender_id: AGENT.id,
    sender_name: AGENT.name,
    content: 'It filters the channel transcript.',
    thread_parent_id: 'msg-human',
    broadcast_to_channel: true,
  }]);

  const frame = sent.find((m) => m.type === 'db_changes' && m.table === 'messages');
  assert.ok(frame, 'expected a messages db_changes frame');
  assert.equal(frame.payload.new.broadcast_to_channel, true);
  assert.equal(frame.payload.new.thread_parent_id, 'msg-human', 'and the parent, so the "from a thread" chip can render');
});

test('sanitizeRealtimeRow does not strip broadcast_to_channel from a messages row', () => {
  const row = {
    id: 'msg-1',
    session_id: SESSION_ID,
    content: 'It filters the channel transcript.',
    thread_parent_id: 'msg-human',
    broadcast_to_channel: true,
  };
  const out = __test.sanitizeRealtimeRow('messages', row);
  assert.equal(out.broadcast_to_channel, true, 'a flag the client never receives never moves a message into the channel view');
  assert.deepEqual(out, row, 'the messages fanout is unfiltered');
});
