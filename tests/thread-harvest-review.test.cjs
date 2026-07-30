// ============================================================================
// tests/thread-harvest-review.test.cjs
// ----------------------------------------------------------------------------
// The review half of thread harvesting: a human reads what a discarded thread
// proposed and either ACCEPTS it (which is the only thing that ever writes
// memory_facts / documents) or dismisses it.
//
// The invariants pinned here:
//   1. Accepting is what writes. Listing and dismissing write NOTHING into the
//      two stores a human trusts most.
//   2. The client names WHICH proposal, never WHAT gets written. The body that
//      reaches memory_facts is read back out of the harvest row.
//   3. Accepting is at-most-once. Two clicks racing must not put the same fact
//      into memory twice, and a decided proposal cannot be re-decided.
//   4. A failed write ROLLS BACK the verdict. "Accepted" with nothing behind it
//      is the one outcome this feature must not be able to produce.
//   5. Two people answering DIFFERENT proposals on the same harvest must not
//      clobber each other — one element is replaced, never the whole array.
//   6. Only harvests that actually proposed something are listed.
//   7. Every path goes through enforceWorkspaceRole.
// ============================================================================

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createThreadHarvest,
  decidedFinding,
  findingDecision,
  harvestAcceptTarget,
  harvestDocumentContent,
  harvestReviewCounts,
} = require('../server/thread-harvest.cjs');

// --- the pure half ----------------------------------------------------------

test('a verdict is only a verdict if it is one of the two we recognise', () => {
  assert.equal(findingDecision({ decision: 'accepted' }), 'accepted');
  assert.equal(findingDecision({ decision: 'DISMISSED' }), 'dismissed');
  assert.equal(findingDecision({}), '', 'no verdict means still waiting on someone');
  // A row whose decision field says something we did not write is NOT a
  // decision. Treating it as one would hide a proposal nobody ever answered.
  assert.equal(findingDecision({ decision: 'maybe' }), '');
  assert.equal(findingDecision(null), '');
});

test('three kinds land in the two stores that are actually writable', () => {
  assert.equal(harvestAcceptTarget({ kind: 'memory' }).table, 'memory_facts');
  assert.equal(harvestAcceptTarget({ kind: 'memory' }).category, 'suggested',
    'its own category, so a suggested fact is distinguishable from a typed one');
  assert.equal(harvestAcceptTarget({ kind: 'doc' }).table, 'documents');
  // A skill has no app-side store — agent_skill_documents is daemon-owned and
  // read-only — so it becomes a written page rather than a claim nobody checked.
  assert.equal(harvestAcceptTarget({ kind: 'skill' }).table, 'documents');
  assert.equal(harvestAcceptTarget({ kind: 'skill' }).folder, 'Playbooks');
  assert.notEqual(harvestAcceptTarget({ kind: 'doc' }).folder, harvestAcceptTarget({ kind: 'skill' }).folder);
  assert.equal(harvestAcceptTarget({ kind: 'wat' }), null);
  assert.equal(harvestAcceptTarget(null), null);
});

test('an accepted page carries its provenance in the DOCUMENT, not just on screen', () => {
  const content = harvestDocumentContent(
    { body: 'Deploy from a clean clone.' },
    { threadTitle: 'the netlify thing', discardedAt: '2026-07-29T09:00:00Z' },
  );
  assert.ok(content.startsWith('Deploy from a clean clone.'), 'the body leads');
  assert.match(content, /Suggested from a discarded conversation/);
  assert.match(content, /the netlify thing/);
  assert.match(content, /2026-07-29/);
  // The thread is already deleted, so a reader six months out has no other way
  // to learn a model proposed this and a person waved it through.
  assert.match(content, /proposed by a model, accepted by a person/);
});

test('provenance degrades rather than printing an empty quote', () => {
  const content = harvestDocumentContent({ body: 'Body.' }, {});
  assert.ok(content.startsWith('Body.'));
  assert.ok(!content.includes('""'), 'no empty quotes where a title should be');
});

test('a verdict is written onto a copy, leaving the original finding untouched', () => {
  const original = { kind: 'memory', title: 'T', body: 'B' };
  const next = decidedFinding(original, { decision: 'accepted', userId: 'u1', userName: 'Jason', targetTable: 'memory_facts' });
  assert.equal(original.decision, undefined, 'the input is not mutated');
  assert.equal(next.decision, 'accepted');
  assert.equal(next.body, 'B', 'the model body survives the verdict');
  assert.equal(next.decided_by, 'u1');
  assert.equal(next.decided_by_name, 'Jason');
  assert.equal(next.target_table, 'memory_facts');
  assert.ok(next.decided_at);
});

test('review counts say how much of a harvest still needs a person', () => {
  const counts = harvestReviewCounts([
    { decision: 'accepted' }, { decision: 'dismissed' }, {}, { decision: 'nonsense' },
  ]);
  assert.deepEqual(counts, { total: 4, pending: 2, accepted: 1, dismissed: 1 });
  assert.deepEqual(harvestReviewCounts([]), { total: 0, pending: 0, accepted: 0, dismissed: 0 });
  assert.deepEqual(harvestReviewCounts(null), { total: 0, pending: 0, accepted: 0, dismissed: 0 });
});

// --- the review routes ------------------------------------------------------

const FINDINGS = [
  { kind: 'memory', title: 'Fly ships the working dir', body: 'Deploy from a clean clone.', why: 'cost a broken deploy' },
  { kind: 'doc', title: 'Why two backends', body: 'One database, two servers.', why: 'keeps being re-explained' },
];

/**
 * A db that models the two things this code actually leans on: jsonb_set
 * replacing ONE array element, and the `decision is empty` guard being a
 * compare-and-set. Anything it does not recognise throws, so a statement that
 * silently stopped matching shows up as a failure instead of an empty result.
 */
function installReview({ harvest, roleError = null, insertError = null } = {}) {
  const calls = [];
  let row = harvest === undefined
    ? {
      id: 'h1',
      workspace_id: 'ws-1',
      session_id: 's-1',
      status: 'done',
      reason: 'deleted',
      findings: FINDINGS.map((f) => ({ ...f })),
      created_at: '2026-07-29T08:00:00Z',
      session_title: 'the netlify thing',
      session_deleted_at: '2026-07-29T09:00:00Z',
    }
    : harvest;
  const inserted = [];
  const broadcast = [];

  const db = {
    async unsafe(sql, params = []) {
      const n = String(sql).replace(/\s+/g, ' ').trim();
      calls.push({ n, params });
      if (n.startsWith('select h.id, h.workspace_id')) {
        if (!row || row.workspace_id !== params[0]) return [];
        if (row.status !== 'done') return [];
        if (!Array.isArray(row.findings) || row.findings.length === 0) return [];
        return [row];
      }
      if (n.startsWith('select h.*, s.title')) {
        return row && row.id === params[0] && row.workspace_id === params[1] ? [row] : [];
      }
      if (n.startsWith('select display_name, email from app_users')) {
        return [{ display_name: 'Jason', email: 'jason@example.com' }];
      }
      if (n.startsWith('update thread_harvests set findings = jsonb_set')) {
        const position = Number(params[1]);
        const guarded = n.includes("coalesce(findings->($2::int)->>'decision', '') = ''");
        const current = row.findings[position];
        if (guarded && String(current?.decision || '')) return [];
        const next = row.findings.slice();
        next[position] = params[2];
        row = { ...row, findings: next };
        return [row];
      }
      if (n.startsWith('insert into memory_facts')) {
        if (insertError) throw new Error(insertError);
        const created = { id: 'fact-1', workspace_id: params[0], fact: params[1], category: params[2] };
        inserted.push(created);
        return [created];
      }
      if (n.startsWith('insert into documents')) {
        if (insertError) throw new Error(insertError);
        const created = { id: 'doc-1', workspace_id: params[0], title: params[1], content: params[2], folder: params[3] };
        inserted.push(created);
        return [created];
      }
      throw new Error(`unexpected sql: ${n.slice(0, 90)}`);
    },
  };

  const roles = [];
  const harvestApi = createThreadHarvest({
    getDb: () => db,
    runAnthropicCompletion: async () => { throw new Error('the review path must never call the model'); },
    notifyDbSubscribers: (table, event, rows) => broadcast.push({ table, event, rows }),
    enforceWorkspaceRole: async (userId, workspaceId, mode) => {
      roles.push({ userId, workspaceId, mode });
      if (roleError) throw Object.assign(new Error(roleError), { status: 403 });
    },
  });

  return { harvestApi, calls, roles, inserted, broadcast, current: () => row };
}

const wroteInto = (calls) => calls.filter((c) => /^insert into (memory_facts|documents)/.test(c.n));

test('accepting a memory proposal is what writes it into memory_facts', async () => {
  const { harvestApi, inserted, current, broadcast } = installReview();

  await harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' });

  assert.equal(inserted.length, 1);
  assert.equal(inserted[0].fact, 'Deploy from a clean clone.', 'the MODEL body is what lands, not anything the client sent');
  assert.equal(inserted[0].category, 'suggested');
  assert.equal(inserted[0].workspace_id, 'ws-1');
  const finding = current().findings[0];
  assert.equal(finding.decision, 'accepted');
  assert.equal(finding.target_id, 'fact-1', 'the proposal points at the row it became');
  assert.equal(finding.decided_by_name, 'Jason');
  // The other proposal on the same harvest is untouched.
  assert.equal(findingDecision(current().findings[1]), '');
  assert.ok(broadcast.some((b) => b.table === 'memory_facts' && b.event === 'INSERT'));
  assert.ok(broadcast.some((b) => b.table === 'thread_harvests' && b.event === 'UPDATE'));
});

test('accepting a doc proposal writes a page carrying its provenance', async () => {
  const { harvestApi, inserted } = installReview();

  await harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 1, decision: 'accept' });

  assert.equal(inserted[0].title, 'Why two backends');
  assert.equal(inserted[0].folder, 'Suggestions');
  assert.match(inserted[0].content, /One database, two servers\./);
  assert.match(inserted[0].content, /the netlify thing/);
});

test('dismissing writes NOTHING into memory or documents', async () => {
  const { harvestApi, calls, current } = installReview();

  await harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'dismiss' });

  assert.equal(current().findings[0].decision, 'dismissed');
  assert.equal(wroteInto(calls).length, 0, 'a dismissal is not a quiet write');
});

test('listing writes nothing at all and skips harvests with nothing to answer', async () => {
  const { harvestApi, calls } = installReview();
  const rows = await harvestApi.listThreadHarvests({ workspaceId: 'ws-1' });
  assert.equal(rows.length, 1);
  assert.equal(wroteInto(calls).length, 0);
  assert.match(calls[0].n, /h\.status = 'done'/);
  assert.match(calls[0].n, /jsonb_array_length\(h\.findings\) > 0/,
    'a skipped or empty harvest is a correct outcome with nothing to review');

  // An error'd harvest really is filtered out, not just filtered in the SQL text.
  const errored = installReview({ harvest: { id: 'h2', workspace_id: 'ws-1', status: 'error', findings: [] } });
  assert.deepEqual(await errored.harvestApi.listThreadHarvests({ workspaceId: 'ws-1' }), []);
});

test('a proposal cannot be decided twice, so two clicks cannot double-write memory', async () => {
  const { harvestApi, inserted } = installReview();

  await harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' });
  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' }),
    (error) => error.status === 409 && error.code === 'already_decided',
  );

  assert.equal(inserted.length, 1, 'the same fact is in memory once, not twice');
});

test('the claim is a compare-and-set, so a racing second click writes nothing', async () => {
  const { harvestApi, inserted, current } = installReview();

  // Both callers read an undecided finding; the loser's guarded UPDATE matches
  // no row. Without the guard this test writes memory twice.
  const [first, second] = await Promise.allSettled([
    harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' }),
    harvestApi.decideHarvestFinding({ userId: 'u2', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' }),
  ]);

  assert.equal(inserted.length, 1, 'one accept, one row in memory');
  assert.equal([first, second].filter((r) => r.status === 'rejected').length, 1);
  assert.equal(current().findings[0].decision, 'accepted');
});

test('a failed write rolls the verdict back instead of claiming an accept that never happened', async () => {
  const { harvestApi, current, inserted } = installReview({ insertError: 'memory_facts is on fire' });

  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' }),
    /on fire/,
  );

  assert.equal(inserted.length, 0);
  assert.equal(findingDecision(current().findings[0]), '',
    'the proposal is back in the queue, not sitting there reading "accepted"');
});

test('two people answering different proposals on one harvest do not clobber each other', async () => {
  const { harvestApi, current } = installReview();

  await harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' });
  await harvestApi.decideHarvestFinding({ userId: 'u2', workspaceId: 'ws-1', harvestId: 'h1', index: 1, decision: 'dismiss' });

  assert.equal(current().findings[0].decision, 'accepted');
  assert.equal(current().findings[1].decision, 'dismissed');
});

test('every review path is gated on workspace membership', async () => {
  const denied = installReview({ roleError: 'not a member' });
  await assert.rejects(
    () => denied.harvestApi.decideHarvestFinding({ userId: 'u9', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' }),
    /not a member/,
  );
  assert.equal(wroteInto(denied.calls).length, 0, 'the role check runs BEFORE anything is written');
  assert.deepEqual(denied.roles[0], { userId: 'u9', workspaceId: 'ws-1', mode: 'write' });
});

test('a harvest belonging to another workspace is not found, not readable', async () => {
  const { harvestApi } = installReview();
  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-OTHER', harvestId: 'h1', index: 0, decision: 'accept' }),
    (error) => error.status === 404,
  );
});

test('a proposal index the harvest does not have is refused', async () => {
  const { harvestApi, calls } = installReview();
  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 99, decision: 'accept' }),
    (error) => error.status === 404,
  );
  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: -1, decision: 'accept' }),
    /whole number/,
  );
  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 1.5, decision: 'accept' }),
    /whole number/,
  );
  assert.equal(wroteInto(calls).length, 0);
});

test('only accept and dismiss are decisions', async () => {
  const { harvestApi, calls } = installReview();
  for (const decision of ['', 'maybe', 'delete', null]) {
    await assert.rejects(
      () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision }),
      /accept or dismiss/,
    );
  }
  assert.equal(wroteInto(calls).length, 0);
});

test('a harvest that is still running has nothing to review', async () => {
  const { harvestApi } = installReview({
    harvest: { id: 'h1', workspace_id: 'ws-1', status: 'running', findings: [] },
  });
  await assert.rejects(
    () => harvestApi.decideHarvestFinding({ userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept' }),
    (error) => error.status === 409,
  );
});

// ---------------------------------------------------------------------------
// A suggestion mined from a conversation that is private NOW cannot be accepted.
//
// listThreadHarvests already hides those rows, but hiding is not reach: this
// path takes an ID, so the row is reachable whether or not it was listed. The
// boot-time purge in ensureRuntimeSchema removes rows for private sessions, and
// that closes the generic /backend/db/select path — but it runs at boot, so a
// conversation turned private while somebody has the review screen open is
// still decidable until the next restart. Accepting one copies a private
// conversation into memory_facts or documents, where the whole workspace reads
// it, and that is the leak the DM work shipped today exists to prevent.
// ---------------------------------------------------------------------------

test('the decide fetch refuses a suggestion whose conversation is private', async () => {
  const { harvestApi, calls } = installReview();

  await harvestApi.decideHarvestFinding({
    userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept',
  });

  const fetched = calls.find((c) => c.n.startsWith('select h.*, s.title'));
  assert.ok(fetched, 'the decide path loads the row it is about to act on');
  // Both halves of the test the read authorizer uses: the column, and the folder
  // that carries the DMs predating it.
  assert.match(
    fetched.n,
    /coalesce\(s\.visibility, 'workspace'\) <> 'private'/,
    'a private conversation is excluded by the query, not after the fetch',
  );
  assert.match(
    fetched.n,
    /coalesce\(s\.folder, ''\) <> 'Direct messages'/,
    'the older folder-shaped DMs are excluded too',
  );
});

test('a hard-deleted conversation is still decidable', async () => {
  // The privacy clause is on a LEFT join, so it must pass when the session row
  // is gone entirely — coalesce over NULL, not NULL propagating into a refusal.
  // Losing the thread must not strand the proposals mined from it, which is the
  // reason the join is LEFT in the first place.
  const { harvestApi, inserted } = installReview({
    harvest: {
      id: 'h1',
      workspace_id: 'ws-1',
      session_id: 's-gone',
      status: 'done',
      reason: 'deleted',
      findings: [{ kind: 'memory', title: 'a fact', body: 'the fact itself' }],
      created_at: '2026-07-29T08:00:00Z',
      session_title: null,
      session_deleted_at: null,
    },
  });

  await harvestApi.decideHarvestFinding({
    userId: 'u1', workspaceId: 'ws-1', harvestId: 'h1', index: 0, decision: 'accept',
  });

  assert.equal(inserted.length, 1, 'the proposal is still acceptable without its source thread');
});
