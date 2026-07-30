// ============================================================================
// tests/thread-harvest.test.cjs
// ----------------------------------------------------------------------------
// A thread that gets cleared or soft-deleted is usually the END of a piece of
// work, which makes it the moment the workspace is most likely to LOSE what the
// work taught it. Discarding one now queues a background analysis for the
// skills, memories and docs worth keeping.
//
// The invariants pinned here:
//   1. Only the null -> timestamp EDGE queues. A repeat delete or an undelete
//      must not queue, or every retry bills another model call.
//   2. The transcript is bounded and excludes tool chips, and when the cap bites
//      it keeps the NEWEST messages — a thread's conclusion is the point.
//   3. A malformed model answer yields NO findings rather than half-parsed ones:
//      a broken proposal shown to a human as a suggestion is worse than none.
//   4. A thread too small to have taught anything is 'skipped', never sent to
//      the model, and never recorded as an error.
//   5. Claiming is compare-and-set, so two processes cannot analyse one thread.
//   6. Findings are PROPOSALS. Nothing here writes memory_facts or documents,
//      and nothing un-deletes the thread it read.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createThreadHarvest,
  buildHarvestTranscript,
  harvestMessageLine,
  isDiscardTransition,
  isWorthHarvesting,
  parseHarvestFindings,
  HARVEST_MAX_MESSAGES,
  HARVEST_MAX_MESSAGE_CHARS,
} = require('../server/thread-harvest.cjs');

const msg = (content, extra = {}) => ({ role: 'user', content, sender_name: 'jason', ...extra });

// --- the discard edge -------------------------------------------------------

test('only the null -> timestamp edge counts as discarding a thread', () => {
  assert.equal(isDiscardTransition({ deleted_at: null }, { deleted_at: '2026-07-29T09:00:00Z' }), true);
  // A second delete of the same thread — two clients, or a client that re-sends
  // the same patch. Queuing again would bill a second model call for one answer.
  assert.equal(isDiscardTransition({ deleted_at: '2026-07-28T00:00:00Z' }, { deleted_at: '2026-07-29T00:00:00Z' }), false);
  assert.equal(isDiscardTransition({ deleted_at: '2026-07-29T00:00:00Z' }, { deleted_at: null }), false, 'undelete must not harvest');
  assert.equal(isDiscardTransition({ deleted_at: null }, { deleted_at: null }), false);
  assert.equal(isDiscardTransition(null, null), false, 'a missing before-image is not a discard');
});

// --- transcript building ----------------------------------------------------

test('tool chips are excluded — they say a grep ran, never what it meant', () => {
  assert.equal(harvestMessageLine(msg('Bash · npm test', { message_kind: 'tool_step' })), '');
  assert.equal(harvestMessageLine(msg('the deploy needs a clean clone')), 'jason: the deploy needs a clean clone');
});

test('a message is clipped, and whitespace collapsed, so one paste cannot eat the budget', () => {
  const line = harvestMessageLine(msg('x'.repeat(HARVEST_MAX_MESSAGE_CHARS + 500)));
  assert.ok(line.length < HARVEST_MAX_MESSAGE_CHARS + 60);
  assert.ok(line.endsWith('…'));
  assert.equal(harvestMessageLine(msg('a\n\n  b\tc')), 'jason: a b c');
});

test('when the message cap bites it keeps the NEWEST messages', () => {
  const many = Array.from({ length: HARVEST_MAX_MESSAGES + 25 }, (_, i) => msg(`line ${i}`));
  const { transcript, messageCount } = buildHarvestTranscript(many);
  assert.equal(messageCount, HARVEST_MAX_MESSAGES);
  // The conclusion is what a harvest is after; the opening is someone finding
  // their footing.
  assert.ok(transcript.includes(`line ${HARVEST_MAX_MESSAGES + 24}`), 'the last message survives');
  assert.ok(!transcript.includes('line 0:'), 'the first message is dropped');
});

test('empty and non-text messages contribute nothing', () => {
  const { messageCount } = buildHarvestTranscript([msg(''), msg('   '), { role: 'user', content: null }, null]);
  assert.equal(messageCount, 0);
});

test('a thread too small to have taught anything is not worth a model call', () => {
  assert.equal(isWorthHarvesting([msg('hi'), msg('hello')]), false);
  assert.equal(isWorthHarvesting(Array.from({ length: 6 }, (_, i) => msg(`m${i}`))), true);
  // Six tool chips are still nothing to learn from.
  assert.equal(isWorthHarvesting(Array.from({ length: 6 }, () => msg('Bash · ls', { message_kind: 'tool_step' }))), false);
});

// --- parsing the model's answer --------------------------------------------

test('findings parse out of a code fence and out of surrounding prose', () => {
  const fenced = parseHarvestFindings('Sure!\n```json\n{"findings":[{"kind":"skill","title":"Deploy","body":"steps","why":"reuse"}]}\n```');
  assert.deepEqual(fenced, [{ kind: 'skill', title: 'Deploy', body: 'steps', why: 'reuse' }]);
});

test('anything malformed is DROPPED rather than shown to a human as a suggestion', () => {
  assert.deepEqual(parseHarvestFindings('not json at all'), []);
  assert.deepEqual(parseHarvestFindings('{"findings":[{"kind":"wat","title":"T","body":"B"}]}'), [], 'unknown kind');
  assert.deepEqual(parseHarvestFindings('{"findings":[{"kind":"memory","title":"","body":"B"}]}'), [], 'no title');
  assert.deepEqual(parseHarvestFindings('{"findings":[{"kind":"memory","title":"T","body":""}]}'), [], 'no body');
  assert.deepEqual(parseHarvestFindings('{"findings":"nope"}'), []);
  assert.deepEqual(parseHarvestFindings(''), []);
  assert.deepEqual(parseHarvestFindings(null), []);
});

test('an honest empty answer is a valid answer, not an error', () => {
  assert.deepEqual(parseHarvestFindings('{"findings":[]}'), []);
});

// --- the worker -------------------------------------------------------------

function installHarvest({ pending, messages, completion, session } = {}) {
  const calls = [];
  let row = pending === undefined
    ? { id: 'h1', workspace_id: 'ws-1', session_id: 's-1', status: 'pending' }
    : pending;
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('insert into thread_harvests')) return [{ id: 'h-new', session_id: params[1] }];
      if (n.startsWith('update thread_harvests set status = \'running\'')) {
        if (!row || row.status !== 'pending') return [];
        row = { ...row, status: 'running' };
        return [row];
      }
      if (n.startsWith('update thread_harvests set status = $2')) {
        row = { ...row, status: params[1], findings: params[2], error: params[3] };
        return [row];
      }
      if (n.startsWith('select id, title, workspace_id from chat_sessions')) {
        return session === null ? [] : [session || { id: 's-1', title: 'A thread', workspace_id: 'ws-1' }];
      }
      if (n.startsWith('select role, content, sender_name')) return messages || [];
      return [];
    },
  };
  const harvest = createThreadHarvest({
    getDb: () => db,
    runAnthropicCompletion: async (args) => {
      calls.push({ n: 'MODEL', params: [args] });
      if (typeof completion === 'function') return completion(args);
      return completion ?? '{"findings":[]}';
    },
  });
  return { harvest, calls, current: () => row };
}

const sixMessages = Array.from({ length: 6 }, (_, i) => msg(`we learned thing ${i}`));

test('a discarded thread is analysed and its findings stored as proposals', async () => {
  const { harvest, calls, current } = installHarvest({
    messages: sixMessages,
    completion: '{"findings":[{"kind":"memory","title":"Fly ships the working dir","body":"Deploy from a clean clone.","why":"cost a broken deploy"}]}',
  });

  await harvest.runOneThreadHarvest();

  assert.equal(current().status, 'done');
  assert.deepEqual(current().findings, [{
    kind: 'memory', title: 'Fly ships the working dir', body: 'Deploy from a clean clone.', why: 'cost a broken deploy',
  }]);
  // PROPOSALS. Nothing may write the two stores a human trusts most, and nothing
  // may un-delete the thread it just read.
  assert.ok(!calls.some((c) => /insert into memory_facts|insert into documents/.test(c.n)), 'must not write memory or docs');
  assert.ok(!calls.some((c) => /update chat_sessions/.test(c.n)), 'must not touch the discarded thread');
});

test('a thread with nothing to learn is skipped without calling the model', async () => {
  const { harvest, calls, current } = installHarvest({ messages: [msg('hi'), msg('bye')] });

  await harvest.runOneThreadHarvest();

  assert.equal(current().status, 'skipped', 'nothing went wrong — there was nothing to learn');
  assert.ok(!calls.some((c) => c.n === 'MODEL'), 'no model call is billed for a two-line thread');
});

test('the transcript, not the raw rows, is what reaches the model', async () => {
  const { harvest, calls } = installHarvest({
    messages: [...sixMessages, msg('Bash · rm -rf', { message_kind: 'tool_step' })],
  });

  await harvest.runOneThreadHarvest();

  const model = calls.find((c) => c.n === 'MODEL');
  assert.ok(model, 'the model was called');
  const prompt = model.params[0].messages[0].content;
  assert.ok(prompt.includes('we learned thing 5'), 'real messages are included');
  assert.ok(!prompt.includes('rm -rf'), 'tool chips are not');
  assert.equal(model.params[0].usageKind, 'thread_harvest', 'metered under its own kind, not as a chat turn');
});

test('a model failure is recorded on the row instead of losing the harvest silently', async () => {
  const { harvest, current } = installHarvest({
    messages: sixMessages,
    completion: () => { throw new Error('rate limited'); },
  });

  await harvest.runOneThreadHarvest();

  assert.equal(current().status, 'error');
  assert.match(String(current().error), /rate limited/);
});

test('a garbled model answer settles as done with no findings, never half-parsed ones', async () => {
  const { harvest, current } = installHarvest({ messages: sixMessages, completion: 'I think maybe you should keep the deploy thing?' });

  await harvest.runOneThreadHarvest();

  assert.equal(current().status, 'done');
  assert.deepEqual(current().findings, []);
});

test('claiming is compare-and-set, so a second worker gets nothing', async () => {
  const { harvest, calls } = installHarvest({ messages: sixMessages });

  await harvest.runOneThreadHarvest();
  const before = calls.length;
  const second = await harvest.runOneThreadHarvest();

  assert.equal(second, null, 'the row is no longer pending');
  assert.ok(!calls.slice(before).some((c) => c.n === 'MODEL'), 'and no second model call is billed');
});

test('nothing queued means nothing runs', async () => {
  const { harvest, calls } = installHarvest({ pending: null });
  assert.equal(await harvest.runOneThreadHarvest(), null);
  assert.ok(!calls.some((c) => c.n === 'MODEL'));
});

test('a queue failure never costs the human their delete', async () => {
  const harvest = createThreadHarvest({
    getDb: () => ({ async unsafe() { throw new Error('db down'); } }),
    runAnthropicCompletion: async () => '{"findings":[]}',
  });
  // Resolves null rather than rejecting: the caller is fire-and-forget after the
  // delete has already been written and broadcast.
  assert.equal(await harvest.queueThreadHarvest({ workspaceId: 'ws-1', sessionId: 's-1' }), null);
});

test('the drain is bounded per tick so a backlog cannot stall the shared interval', async () => {
  let remaining = 10;
  const db = {
    async unsafe(sql) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      if (n.startsWith('update thread_harvests set status = \'running\'')) {
        if (remaining <= 0) return [];
        remaining -= 1;
        return [{ id: `h${remaining}`, workspace_id: 'ws-1', session_id: 's-1', status: 'running' }];
      }
      if (n.startsWith('select id, title, workspace_id from chat_sessions')) return [{ id: 's-1', title: 't', workspace_id: 'ws-1' }];
      return [];
    },
  };
  const harvest = createThreadHarvest({ getDb: () => db, runAnthropicCompletion: async () => '{"findings":[]}' });

  const done = await harvest.runDueThreadHarvests(3);
  assert.equal(done.length, 3, 'three per tick, not the whole backlog');
  assert.equal(remaining, 7, 'the rest drains on later ticks');
});
