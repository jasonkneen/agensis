// ============================================================================
// tests/thread-harvest-suggestions.test.cjs
// ----------------------------------------------------------------------------
// Mining EVERY conversation, not just the deleted ones.
//
// The original feature fired on one edge — a thread being soft-deleted — which
// meant it only ever learned from work somebody threw away. It now also reads a
// live conversation once it has gone quiet. Opening that door is cheap to get
// wrong in three specific ways, and this file pins all three:
//
//   1. COST. A live conversation has no end, so without a watermark, a cooldown
//      and a per-sweep cap it would be re-read on every tick, for every chat, at
//      one model call each. Each of those bounds is tested on its own, because
//      each on its own is what stops the bill.
//   2. REPETITION. The same fact surfaces in four different chats. A suggestion
//      the workspace has already been shown — accepted, dismissed, or still
//      waiting — must not come back, or the feature gets switched off.
//   3. PRIVACY. Suggestions are listed to the whole workspace and ride the
//      realtime fanout's open lane, so a DM must never be mined at all. Not on
//      the sweep, and not on delete either.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createThreadHarvest,
  dedupeFindings,
  harvestPrompt,
  suggestionFingerprint,
  HARVEST_MIN_MESSAGES,
  SUGGEST_COOLDOWN_HOURS,
  SUGGEST_IDLE_MINUTES,
  SUGGEST_MAX_AGE_DAYS,
  SUGGEST_SWEEP_LIMIT,
} = require('../server/thread-harvest.cjs');

const msg = (content, extra = {}) => ({ role: 'user', content, sender_name: 'jason', ...extra });

const sixMessages = Array.from({ length: 6 }, (_, i) => ({
  ...msg(`we learned thing ${i}`),
  created_at: `2026-07-2${i + 1}T10:00:00Z`,
}));

/**
 * A fake db that records every statement and answers the ones the worker asks.
 *
 * `overrides` is keyed by a prefix of the normalised SQL so a test can change
 * ONE answer — whether the session is private, where the watermark is — without
 * restating the rest.
 */
function installHarvest({
  pending,
  messages,
  completion,
  session,
  cursorAt = null,
  priorFindings = [],
  privateSession = false,
  failOn = '',
} = {}) {
  const calls = [];
  let row = pending === undefined
    ? { id: 'h1', workspace_id: 'ws-1', session_id: 's-1', status: 'pending', reason: 'deleted' }
    : pending;
  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (failOn && n.startsWith(failOn)) throw new Error('db down');
      if (n.startsWith('select 1 from chat_sessions')) return privateSession ? [{ '?column?': 1 }] : [];
      if (n.startsWith('insert into thread_harvests (workspace_id, session_id, status, reason, requested_by)')) {
        return [{ id: 'h-new', session_id: params[1] }];
      }
      if (n.startsWith('insert into thread_harvests (workspace_id, session_id, status, reason) select')) {
        return [{ id: 'h-swept', session_id: 's-9' }];
      }
      if (n.startsWith("update thread_harvests set status = 'running'")) {
        if (!row || row.status !== 'pending') return [];
        row = { ...row, status: 'running' };
        return [row];
      }
      if (n.startsWith('update thread_harvests set status = $2')) {
        row = { ...row, status: params[1], findings: params[2], error: params[3], cursor_at: params[4] };
        return [row];
      }
      if (n.startsWith('select max(cursor_at) as cursor_at')) return [{ cursor_at: cursorAt }];
      if (n.startsWith("select f->>'kind' as kind")) return priorFindings;
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
  const find = (prefix) => calls.find((c) => c.n.startsWith(prefix));
  return { harvest, calls, find, current: () => row };
}

// --- privacy ----------------------------------------------------------------

test('a private conversation is never mined, whichever trigger fired', async () => {
  const { harvest, calls } = installHarvest({ privateSession: true });

  const queued = await harvest.queueThreadHarvest({ workspaceId: 'ws-1', sessionId: 'dm-1', reason: 'deleted' });

  assert.equal(queued, null, 'deleting a DM must not queue an analysis of it');
  // Not merely unlisted afterwards — never written. A suggestion drawn out of a
  // DM rides the realtime fanout's OPEN lane (server/realtime.cjs only routes
  // chat_sessions down the members-only lane), so the row existing at all puts
  // the DM's contents on every socket in the workspace.
  assert.ok(
    !calls.some((c) => c.n.startsWith('insert into thread_harvests')),
    'no row is inserted for a private session',
  );
});

test('a workspace-visible conversation still queues normally', async () => {
  const { harvest, calls } = installHarvest({ privateSession: false });

  const queued = await harvest.queueThreadHarvest({ workspaceId: 'ws-1', sessionId: 's-1', reason: 'deleted' });

  assert.ok(queued, 'the ordinary case is unaffected');
  assert.ok(calls.some((c) => c.n.startsWith('insert into thread_harvests')));
});

test('a visibility lookup that fails queues NOTHING — privacy fails closed', async () => {
  // Everywhere else in this module a failure fails open, because a missing
  // suggestion must never cost somebody their delete. Privacy is the exception:
  // if the database will not say whether this is a DM, the safe answer is the
  // one that discloses nothing.
  const { harvest, calls } = installHarvest({ failOn: 'select 1 from chat_sessions' });

  assert.equal(await harvest.queueThreadHarvest({ workspaceId: 'ws-1', sessionId: 's-1' }), null);
  assert.ok(!calls.some((c) => c.n.startsWith('insert into thread_harvests')));
});

test('the list query refuses private conversations as a second line of defence', async () => {
  const { harvest, find } = installHarvest({});

  await harvest.listThreadHarvests({ workspaceId: 'ws-1' });

  // Pins the predicate, not the database. queueThreadHarvest already stops a DM
  // being mined, so on a clean database this clause filters nothing — it is
  // here for rows queued BEFORE that rule existed, which are in production now.
  const listed = find('select h.id, h.workspace_id');
  assert.ok(listed, 'the list ran');
  assert.match(listed.n, /coalesce\(s\.visibility, 'workspace'\) <> 'private'/);
  assert.match(listed.n, /coalesce\(s\.folder, ''\) <> 'Direct messages'/);
});

// --- the watermark ----------------------------------------------------------

test('a finished analysis records how far it read', async () => {
  const { harvest, current } = installHarvest({ messages: sixMessages });

  await harvest.runOneThreadHarvest();

  assert.equal(current().status, 'done');
  assert.equal(current().cursor_at, '2026-07-26T10:00:00Z', 'the newest message it read');
});

test('the next analysis starts AFTER the watermark, not at message 1', async () => {
  const { harvest, find } = installHarvest({
    messages: sixMessages,
    cursorAt: '2026-07-23T10:00:00Z',
  });

  await harvest.runOneThreadHarvest();

  const read = find('select role, content, sender_name');
  assert.equal(read.params[1], '2026-07-23T10:00:00Z', 'the watermark is bound to the read');
  // Binding it is not using it. Without the predicate the parameter is inert
  // and a long channel is re-read, and re-billed, from message 1 forever.
  assert.match(read.n, /created_at > \$2::timestamptz/);
});

test('a SKIPPED analysis must not move the watermark', async () => {
  // The bug this exists to prevent: a session with three new messages is queued,
  // skipped as too small, and — if the mark moved — those three messages become
  // unreachable, so the thing they taught is never proposed at all.
  const { harvest, current } = installHarvest({
    messages: [{ ...msg('hi'), created_at: '2026-07-29T10:00:00Z' }],
  });

  await harvest.runOneThreadHarvest();

  assert.equal(current().status, 'skipped');
  assert.equal(current().cursor_at, null, 'nothing was considered, so nothing is marked as considered');
});

test('an incremental run tells the model the earlier part was already read', async () => {
  const { harvest, find } = installHarvest({ messages: sixMessages, cursorAt: '2026-07-21T10:00:00Z' });

  await harvest.runOneThreadHarvest();

  const prompt = find('MODEL').params[0].messages[0].content;
  // Without this the model opens with "the conversation begins mid-discussion"
  // and reports the missing context as the finding.
  assert.match(prompt, /ALREADY been reviewed/);
});

// --- deduplication ----------------------------------------------------------

test('a suggestion this workspace has already been shown is dropped before it is stored', async () => {
  const { harvest, current } = installHarvest({
    messages: sixMessages,
    priorFindings: [{ kind: 'memory', title: 'Anything', body: 'Deploy from a clean clone.' }],
    completion: JSON.stringify({
      findings: [
        { kind: 'memory', title: 'Fly ships the working dir', body: 'Deploy from a clean clone!', why: 'x' },
        { kind: 'memory', title: 'Something new', body: 'Netlify caches the app shell.', why: 'y' },
      ],
    }),
  });

  await harvest.runOneThreadHarvest();

  assert.deepEqual(current().findings.map((f) => f.title), ['Something new'],
    'the repeat is gone and the genuinely new one survives');
});

test('a dedup lookup that fails costs a repeat, never the analysis', async () => {
  const { harvest, current } = installHarvest({
    messages: sixMessages,
    failOn: "select f->>'kind' as kind",
    completion: '{"findings":[{"kind":"memory","title":"T","body":"B","why":"w"}]}',
  });

  await harvest.runOneThreadHarvest();

  // Fails OPEN, unlike the privacy check. Showing somebody a duplicate is a
  // papercut; losing the whole analysis is the work.
  assert.equal(current().status, 'done');
  assert.equal(current().findings.length, 1);
});

test('a memory is its FACT and a doc is its SUBJECT', () => {
  // Two headings over one fact are one suggestion; two pages about different
  // things may open with the same sentence.
  assert.equal(
    suggestionFingerprint({ kind: 'memory', title: 'One', body: 'Deploy from a clean clone.' }),
    suggestionFingerprint({ kind: 'memory', title: 'Two', body: 'deploy from a clean clone' }),
  );
  assert.notEqual(
    suggestionFingerprint({ kind: 'doc', title: 'Why two backends', body: 'Same opener.' }),
    suggestionFingerprint({ kind: 'doc', title: 'Why one database', body: 'Same opener.' }),
  );
  // A skill called X and a doc called X are different things to accept, and
  // they land in different folders.
  assert.notEqual(
    suggestionFingerprint({ kind: 'skill', title: 'Deploying' }),
    suggestionFingerprint({ kind: 'doc', title: 'Deploying' }),
  );
  assert.equal(suggestionFingerprint({ kind: 'memory', body: '   ' }), '', 'nothing to key on');
  assert.equal(suggestionFingerprint(null), '');
});

test('one analysis proposing the same thing twice only asks once', () => {
  const kept = dedupeFindings([
    { kind: 'memory', title: 'A', body: 'Deploy from a clean clone.' },
    { kind: 'memory', title: 'B', body: 'Deploy from a clean clone!' },
    { kind: 'doc', title: 'Elsewhere', body: 'x' },
  ], []);
  assert.deepEqual(kept.map((f) => f.title), ['A', 'Elsewhere']);
});

test('a suggestion with no usable fingerprint is kept, not silently binned', () => {
  // It is the model's answer. Dropping it because our normalisation came out
  // empty would lose a real suggestion to a quirk of the key.
  const kept = dedupeFindings([{ kind: 'memory', title: 'A', body: '???' }], ['memory:something']);
  assert.equal(kept.length, 1);
});

// --- the idle sweep ---------------------------------------------------------

test('the idle sweep is bounded, and every bound is in the statement', async () => {
  const { harvest, find } = installHarvest({});

  await harvest.sweepIdleSessionHarvests();

  const swept = find('insert into thread_harvests (workspace_id, session_id, status, reason) select');
  assert.ok(swept, 'the sweep ran');
  assert.deepEqual(swept.params, [
    SUGGEST_IDLE_MINUTES, SUGGEST_MAX_AGE_DAYS, HARVEST_MIN_MESSAGES,
    SUGGEST_COOLDOWN_HOURS, SUGGEST_SWEEP_LIMIT,
  ]);
  // Each clause is a spend limit, so losing any one of them silently multiplies
  // the bill rather than breaking anything a test would otherwise notice.
  assert.match(swept.n, /recent\.last_at < now\(\) - make_interval\(mins => \$1::int\)/, 'idle threshold');
  assert.match(swept.n, /recent\.last_at > now\(\) - make_interval\(days => \$2::int\)/, 'not the whole archive');
  assert.match(swept.n, /recent\.fresh >= \$3::int/, 'enough NEW messages since the watermark');
  assert.match(swept.n, /prior\.last_run_at < now\(\) - make_interval\(hours => \$4::int\)/, 'per-session cooldown');
  assert.match(swept.n, /limit \$5::int/, 'per-sweep cap');
  assert.match(swept.n, /o\.status in \('pending', 'running'\)/, 'nothing already queued for it');
  assert.match(swept.n, /s\.deleted_at is null/, 'deletes come through their own edge');
  assert.match(swept.n, /coalesce\(s\.visibility, 'workspace'\) <> 'private'/, 'DMs are not mined');
  assert.match(swept.n, /coalesce\(s\.folder, ''\) <> 'Direct messages'/, 'nor the older folder-shaped DMs');
});

test('the sweep only counts messages the transcript would actually use', async () => {
  // Otherwise fifty tool chips wake a conversation that then skips for having
  // nothing in it — a queue row and a wasted pass, on every cooldown, forever.
  const { harvest, find } = installHarvest({});

  await harvest.sweepIdleSessionHarvests();

  const swept = find('insert into thread_harvests (workspace_id, session_id, status, reason) select');
  assert.match(swept.n, /coalesce\(m\.message_kind, ''\) = ''/);
  assert.match(swept.n, /coalesce\(m\.content, ''\) <> ''/);
});

test('the sweep enqueues but never spends', async () => {
  const { harvest, calls } = installHarvest({});

  await harvest.sweepIdleSessionHarvests();

  // The model calls stay behind runDueThreadHarvests and its unchanged per-tick
  // cap. If the sweep could call the model directly, its own limit of 5 would
  // become 5 model calls every five minutes with nothing else in the way.
  assert.ok(!calls.some((c) => c.n === 'MODEL'), 'a sweep writes pending rows and nothing else');
});

test('a sweep cannot be asked to enqueue an unbounded number', async () => {
  const { harvest, find } = installHarvest({});

  await harvest.sweepIdleSessionHarvests({ limit: 5000 });

  assert.equal(find('insert into thread_harvests (workspace_id, session_id, status, reason) select').params[4], 25);
});

test('a sweep that fails is silent, not fatal', async () => {
  // It runs on a timer with nobody watching. A failing sweep is a feature that
  // goes quiet; a throwing one is an unhandled rejection on the server.
  const { harvest } = installHarvest({ failOn: 'insert into thread_harvests (workspace_id, session_id, status, reason) select' });

  assert.deepEqual(await harvest.sweepIdleSessionHarvests(), []);
});

// --- what the model is told -------------------------------------------------

test('a quiet conversation is not described to the model as a deleted one', () => {
  const idle = harvestPrompt({ title: 't', transcript: 'x', reason: 'idle' });
  const deleted = harvestPrompt({ title: 't', transcript: 'x', reason: 'deleted' });

  assert.match(idle, /gone quiet/);
  assert.ok(!/discarded/.test(idle), 'it has not been discarded — it is still there');
  assert.match(deleted, /discarded/);
  // Both still ask the same question and take the same answer shape.
  for (const prompt of [idle, deleted]) {
    assert.match(prompt, /"findings":\[/);
    assert.match(prompt, /No secrets, tokens, credentials or personal data/);
  }
});

test('a first read is not told that anything was read before', () => {
  const first = harvestPrompt({ title: 't', transcript: 'x', reason: 'idle', incremental: false });
  assert.ok(!/ALREADY been reviewed/.test(first));
});
