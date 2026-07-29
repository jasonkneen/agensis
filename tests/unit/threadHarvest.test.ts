// ============================================================================
// tests/unit/threadHarvest.test.ts
// ----------------------------------------------------------------------------
// What the harvest review surface shows.
//
// Deleting a chat thread queues an analysis of what was worth keeping, and the
// answer is stored as PROPOSALS. Nothing is written anywhere until a person
// accepts one, so the rules pinned here are mostly about not letting the screen
// imply otherwise:
//
//   1. The index is the RAW array position. Dropping a malformed proposal must
//      not shift the id of the ones after it, or a click accepts the wrong one.
//   2. A malformed proposal is not rendered at all.
//   3. Provenance says all three things: the thread is gone, a model wrote this,
//      nothing has been saved.
//   4. Accepting says WHERE it writes, before the click.
//   5. A proposal duplicating something the workspace already has is FLAGGED,
//      never silently filtered.
//   6. Answered harvests stay in the list; outstanding ones sort first.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  acceptTarget,
  decisionSummary,
  duplicateOf,
  formatHarvestDate,
  harvestCounts,
  harvestFindingFromRow,
  harvestFromRow,
  harvestProvenance,
  kindLabel,
  pendingProposalCount,
  reviewableHarvests,
  sortHarvests,
  type HarvestFinding,
  type ThreadHarvestRow,
} from '../../src/lib/threadHarvest';
import type { Document, MemoryFact } from '../../src/types';

const finding = (over: Partial<Record<string, unknown>> = {}) => ({
  kind: 'memory',
  title: 'Fly ships the working dir',
  body: 'Deploy from a clean clone.',
  why: 'cost a broken deploy once',
  ...over,
});

const row = (over: Partial<ThreadHarvestRow> = {}): ThreadHarvestRow => ({
  id: 'h1',
  workspace_id: 'ws-1',
  session_id: 's-1',
  status: 'done',
  reason: 'deleted',
  findings: [finding()],
  created_at: '2026-07-29T08:00:00Z',
  session_title: 'the netlify thing',
  session_deleted_at: '2026-07-29T09:00:00Z',
  ...over,
});

const fact = (text: string): MemoryFact => ({
  id: `f-${text.length}`,
  workspace_id: 'ws-1',
  fact: text,
  category: 'general',
  created_at: '',
  updated_at: '',
});

const doc = (title: string): Document => ({
  id: `d-${title.length}`,
  workspace_id: 'ws-1',
  title,
  is_favorite: false,
  created_at: '',
  updated_at: '',
});

describe('normalising a stored proposal', () => {
  it('keeps the model text and the verdict together', () => {
    const parsed = harvestFindingFromRow(finding({ decision: 'accepted', decided_by_name: 'Jason', target_table: 'memory_facts', target_id: 'fact-1' }), 3);
    expect(parsed).toMatchObject({
      index: 3,
      kind: 'memory',
      title: 'Fly ships the working dir',
      body: 'Deploy from a clean clone.',
      decision: 'accepted',
      decidedByName: 'Jason',
      targetId: 'fact-1',
    });
  });

  it('treats an unrecognised verdict as still waiting on someone', () => {
    // A row saying something we never write is NOT an answer. Reading it as one
    // would hide a proposal nobody ever decided.
    expect(harvestFindingFromRow(finding({ decision: 'maybe' }), 0)?.decision).toBe('');
    expect(harvestFindingFromRow(finding(), 0)?.decision).toBe('');
  });

  it('refuses anything that is not a recognisable proposal', () => {
    expect(harvestFindingFromRow(finding({ kind: 'wat' }), 0)).toBeNull();
    expect(harvestFindingFromRow(finding({ title: '' }), 0)).toBeNull();
    expect(harvestFindingFromRow(finding({ body: '   ' }), 0)).toBeNull();
    expect(harvestFindingFromRow('nope', 0)).toBeNull();
    expect(harvestFindingFromRow(null, 0)).toBeNull();
  });
});

describe('normalising a harvest row', () => {
  it('indexes findings by their RAW position, so a dropped one cannot shift the rest', () => {
    const harvest = harvestFromRow(row({
      findings: [finding({ kind: 'garbage' }), finding({ title: 'Second' }), finding({ title: 'Third' })],
    }));
    expect(harvest.findings.map(f => f.title)).toEqual(['Second', 'Third']);
    // If these renumbered to 0 and 1, clicking Accept on "Second" would accept
    // the malformed entry at index 0 on the server.
    expect(harvest.findings.map(f => f.index)).toEqual([1, 2]);
  });

  it('survives a thread that has since been hard-deleted', () => {
    const harvest = harvestFromRow(row({ session_title: null, session_deleted_at: null }));
    expect(harvest.threadTitle).toBe('');
    // Losing the title must not lose the proposals, and the queue timestamp is
    // the honest fallback for when the thread went.
    expect(harvest.discardedAt).toBe('2026-07-29T08:00:00Z');
    expect(harvest.findings).toHaveLength(1);
  });

  it('tolerates a findings column that is not an array', () => {
    expect(harvestFromRow(row({ findings: null })).findings).toEqual([]);
    expect(harvestFromRow(row({ findings: 'nope' })).findings).toEqual([]);
  });
});

describe('counting what still needs a person', () => {
  const parsed = (over: Partial<Record<string, unknown>> = {}) =>
    harvestFindingFromRow(finding(over), 0) as HarvestFinding;

  it('counts each verdict separately', () => {
    expect(harvestCounts([parsed({ decision: 'accepted' }), parsed({ decision: 'dismissed' }), parsed()]))
      .toEqual({ total: 3, pending: 1, accepted: 1, dismissed: 1 });
    expect(harvestCounts([])).toEqual({ total: 0, pending: 0, accepted: 0, dismissed: 0 });
  });

  it('adds up across harvests for the badge', () => {
    const a = harvestFromRow(row({ findings: [finding(), finding({ decision: 'accepted' })] }));
    const b = harvestFromRow(row({ id: 'h2', findings: [finding()] }));
    expect(pendingProposalCount([a, b])).toBe(2);
    expect(pendingProposalCount([])).toBe(0);
  });
});

describe('review order', () => {
  const answered = harvestFromRow(row({ id: 'old-but-answered', created_at: '2026-07-29T23:00:00Z', findings: [finding({ decision: 'dismissed' })] }));
  const waiting = harvestFromRow(row({ id: 'waiting', created_at: '2026-07-01T00:00:00Z' }));
  const alsoWaiting = harvestFromRow(row({ id: 'newer-waiting', created_at: '2026-07-20T00:00:00Z' }));

  it('puts anything outstanding first, then newest first', () => {
    // The answered harvest is the NEWEST, so a plain date sort would put it on
    // top and bury the two that need a person.
    expect(sortHarvests([answered, waiting, alsoWaiting]).map(h => h.id))
      .toEqual(['newer-waiting', 'waiting', 'old-but-answered']);
  });

  it('keeps answered harvests rather than emptying the list as you click', () => {
    // The verdict is the record of where a fact in memory came from; a list that
    // vanishes on click gives no way back to check what you just accepted.
    expect(reviewableHarvests([answered]).map(h => h.id)).toEqual(['old-but-answered']);
  });

  it('drops harvests that proposed nothing at all', () => {
    const empty = harvestFromRow(row({ id: 'empty', findings: [] }));
    expect(reviewableHarvests([empty, waiting]).map(h => h.id)).toEqual(['waiting']);
  });
});

describe('saying what accepting does, before the click', () => {
  it('names the store each kind lands in', () => {
    expect(acceptTarget('memory')).toEqual({ table: 'memory_facts', label: 'Team memory' });
    expect(acceptTarget('doc').table).toBe('documents');
  });

  it('admits that a skill becomes a document', () => {
    // There is no app-side skill store — agent_skill_documents is daemon-owned
    // and read-only — so a skill proposal becomes a written page. The label has
    // to say so BEFORE the click, not explain it afterwards.
    const target = acceptTarget('skill');
    expect(target.table).toBe('documents');
    expect(target.label).toMatch(/Documents/);
    expect(target.label).toMatch(/Skills/);
  });

  it('labels kinds in words, never emoji', () => {
    for (const kind of ['memory', 'skill', 'doc'] as const) {
      expect(kindLabel(kind)).toMatch(/^[A-Za-z]+$/);
    }
  });
});

describe('provenance', () => {
  it('says the thread is gone, a model wrote it, and nothing is saved', () => {
    const text = harvestProvenance(harvestFromRow(row()));
    expect(text).toMatch(/Proposed by a model/);
    expect(text).toMatch(/the netlify thing/);
    expect(text).toMatch(/deleted/);
    expect(text).toMatch(/Nothing has been saved yet/);
  });

  it('reads sensibly when the thread had no title', () => {
    const text = harvestProvenance(harvestFromRow(row({ session_title: '' })));
    expect(text).toMatch(/an untitled thread/);
    expect(text).not.toMatch(/""/);
  });

  it('never prints Invalid Date', () => {
    expect(formatHarvestDate('')).toBe('an unknown date');
    expect(formatHarvestDate('not-a-date')).toBe('an unknown date');
    expect(formatHarvestDate('2026-07-29T09:00:00Z')).toMatch(/2026/);
  });
});

describe('flagging something the workspace already knows', () => {
  it('matches a memory proposal against existing facts, ignoring casing and punctuation', () => {
    const proposal = harvestFromRow(row()).findings[0];
    expect(duplicateOf(proposal, [fact('deploy from a clean clone')], [])).toEqual({
      kind: 'fact',
      label: 'deploy from a clean clone',
    });
    expect(duplicateOf(proposal, [fact('Deploy from a dirty clone.')], [])).toBeNull();
    expect(duplicateOf(proposal, [], [])).toBeNull();
  });

  it('matches a doc or skill proposal on its title', () => {
    const docProposal = harvestFromRow(row({ findings: [finding({ kind: 'doc', title: 'Why Two Backends' })] })).findings[0];
    expect(duplicateOf(docProposal, [], [doc('why two backends')])?.kind).toBe('document');
    expect(duplicateOf(docProposal, [], [doc('Something else')])).toBeNull();
  });

  it('flags the duplicate rather than hiding the proposal', () => {
    // A silent filter would decide for the reader. reviewableHarvests knows
    // nothing about existing memory, so a duplicate still renders — with a warning.
    const harvest = harvestFromRow(row());
    expect(reviewableHarvests([harvest])).toHaveLength(1);
    expect(harvestCounts(harvest.findings).pending).toBe(1);
  });
});

describe('what an answered proposal reads as', () => {
  const parsed = (over: Record<string, unknown>) => harvestFindingFromRow(finding(over), 0) as HarvestFinding;

  it('says who, when and where for an accept', () => {
    const text = decisionSummary(parsed({
      decision: 'accepted', decided_by_name: 'Jason', decided_at: '2026-07-29T10:00:00Z', target_table: 'memory_facts',
    }));
    expect(text).toMatch(/^Accepted by Jason/);
    expect(text).toMatch(/into team memory/);
  });

  it('says nothing was written for a dismissal', () => {
    const text = decisionSummary(parsed({ decision: 'dismissed', decided_by_name: 'Jason' }));
    expect(text).toMatch(/^Dismissed by Jason/);
    expect(text).not.toMatch(/memory|document/i);
  });

  it('is empty while a proposal is still waiting', () => {
    expect(decisionSummary(parsed({}))).toBe('');
  });
});
