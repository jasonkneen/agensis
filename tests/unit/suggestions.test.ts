// ============================================================================
// tests/unit/suggestions.test.ts
// ----------------------------------------------------------------------------
// What the Suggestions surface shows.
//
// A conversation is read for what was worth keeping — when it is deleted, and
// again when a live one has gone quiet — and the answer is stored as
// SUGGESTIONS. Nothing is written anywhere until a person accepts one, so the
// rules pinned here are mostly about not letting the screen imply otherwise:
//
//   1. The index is the RAW array position. Dropping a malformed suggestion must
//      not shift the id of the ones after it, or a click accepts the wrong one.
//   2. A malformed suggestion is not rendered at all.
//   3. Provenance says all three things: which conversation and what became of
//      it, a model wrote this, nothing has been saved.
//   4. Accepting says WHERE it writes, before the click.
//   5. A suggestion duplicating something the workspace already has is FLAGGED,
//      never silently filtered.
//   6. Answered sets stay in the list; outstanding ones sort first.
//   7. A conversation that merely went quiet is never described as deleted —
//      it is still there to open, and saying otherwise is a small lie with a
//      large jolt attached.
// ============================================================================

import { describe, expect, it } from 'vitest';
import {
  acceptTarget,
  decisionSummary,
  duplicateOf,
  formatSuggestionDate,
  kindLabel,
  pendingSuggestionCount,
  reviewableSuggestionSets,
  sortSuggestionSets,
  suggestionCounts,
  suggestionFromRow,
  suggestionProvenance,
  suggestionSetFromRow,
  type Suggestion,
  type SuggestionSetRow,
} from '../../src/lib/suggestions';
import type { Document, MemoryFact } from '../../src/types';

const finding = (over: Partial<Record<string, unknown>> = {}) => ({
  kind: 'memory',
  title: 'Fly ships the working dir',
  body: 'Deploy from a clean clone.',
  why: 'cost a broken deploy once',
  ...over,
});

const row = (over: Partial<SuggestionSetRow> = {}): SuggestionSetRow => ({
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

describe('normalising a stored suggestion', () => {
  it('keeps the model text and the verdict together', () => {
    const parsed = suggestionFromRow(finding({ decision: 'accepted', decided_by_name: 'Jason', target_table: 'memory_facts', target_id: 'fact-1' }), 3);
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
    // would hide a suggestion nobody ever decided.
    expect(suggestionFromRow(finding({ decision: 'maybe' }), 0)?.decision).toBe('');
    expect(suggestionFromRow(finding(), 0)?.decision).toBe('');
  });

  it('refuses anything that is not a recognisable suggestion', () => {
    expect(suggestionFromRow(finding({ kind: 'wat' }), 0)).toBeNull();
    expect(suggestionFromRow(finding({ title: '' }), 0)).toBeNull();
    expect(suggestionFromRow(finding({ body: '   ' }), 0)).toBeNull();
    expect(suggestionFromRow('nope', 0)).toBeNull();
    expect(suggestionFromRow(null, 0)).toBeNull();
  });
});

describe('normalising a stored row', () => {
  it('indexes suggestions by their RAW position, so a dropped one cannot shift the rest', () => {
    const set = suggestionSetFromRow(row({
      findings: [finding({ kind: 'garbage' }), finding({ title: 'Second' }), finding({ title: 'Third' })],
    }));
    expect(set.suggestions.map(s => s.title)).toEqual(['Second', 'Third']);
    // If these renumbered to 0 and 1, clicking Accept on "Second" would accept
    // the malformed entry at index 0 on the server.
    expect(set.suggestions.map(s => s.index)).toEqual([1, 2]);
  });

  it('survives a conversation that has since been hard-deleted', () => {
    const set = suggestionSetFromRow(row({ session_title: null, session_deleted_at: null }));
    expect(set.threadTitle).toBe('');
    // Losing the title must not lose the suggestions.
    expect(set.suggestions).toHaveLength(1);
    expect(set.reviewedAt).toBe('2026-07-29T08:00:00Z');
  });

  it('leaves discardedAt EMPTY when the conversation was never discarded', () => {
    // It used to fall back to the queue timestamp. That is right for a deleted
    // thread and wrong for a live one: an idle conversation has no deleted_at
    // because it has not been deleted, and inventing one would let the card
    // print a deletion date for a conversation still sitting in the sidebar.
    const idle = suggestionSetFromRow(row({ reason: 'idle', session_deleted_at: null }));
    expect(idle.discardedAt).toBe('');
    expect(idle.reviewedAt).toBe('2026-07-29T08:00:00Z');
  });

  it('tolerates a findings column that is not an array', () => {
    expect(suggestionSetFromRow(row({ findings: null })).suggestions).toEqual([]);
    expect(suggestionSetFromRow(row({ findings: 'nope' })).suggestions).toEqual([]);
  });
});

describe('counting what still needs a person', () => {
  const parsed = (over: Partial<Record<string, unknown>> = {}) =>
    suggestionFromRow(finding(over), 0) as Suggestion;

  it('counts each verdict separately', () => {
    expect(suggestionCounts([parsed({ decision: 'accepted' }), parsed({ decision: 'dismissed' }), parsed()]))
      .toEqual({ total: 3, pending: 1, accepted: 1, dismissed: 1 });
    expect(suggestionCounts([])).toEqual({ total: 0, pending: 0, accepted: 0, dismissed: 0 });
  });

  it('adds up across conversations for the badge', () => {
    const a = suggestionSetFromRow(row({ findings: [finding(), finding({ decision: 'accepted' })] }));
    const b = suggestionSetFromRow(row({ id: 'h2', findings: [finding()] }));
    expect(pendingSuggestionCount([a, b])).toBe(2);
    expect(pendingSuggestionCount([])).toBe(0);
  });
});

describe('review order', () => {
  const answered = suggestionSetFromRow(row({ id: 'old-but-answered', created_at: '2026-07-29T23:00:00Z', findings: [finding({ decision: 'dismissed' })] }));
  const waiting = suggestionSetFromRow(row({ id: 'waiting', created_at: '2026-07-01T00:00:00Z' }));
  const alsoWaiting = suggestionSetFromRow(row({ id: 'newer-waiting', created_at: '2026-07-20T00:00:00Z' }));

  it('puts anything outstanding first, then newest first', () => {
    // The answered set is the NEWEST, so a plain date sort would put it on top
    // and bury the two that need a person.
    expect(sortSuggestionSets([answered, waiting, alsoWaiting]).map(s => s.id))
      .toEqual(['newer-waiting', 'waiting', 'old-but-answered']);
  });

  it('keeps answered sets rather than emptying the list as you click', () => {
    // The verdict is the record of where a fact in memory came from; a list that
    // vanishes on click gives no way back to check what you just accepted.
    expect(reviewableSuggestionSets([answered]).map(s => s.id)).toEqual(['old-but-answered']);
  });

  it('drops sets that suggested nothing at all', () => {
    const empty = suggestionSetFromRow(row({ id: 'empty', findings: [] }));
    expect(reviewableSuggestionSets([empty, waiting]).map(s => s.id)).toEqual(['waiting']);
  });
});

describe('saying what accepting does, before the click', () => {
  it('names the store each kind lands in', () => {
    expect(acceptTarget('memory')).toEqual({ table: 'memory_facts', label: 'Team memory' });
    expect(acceptTarget('doc')).toEqual({ table: 'documents', label: 'Documents · Suggestions' });
  });

  it('never says "harvest" to a person', () => {
    // The feature is called Suggestions. The table, the routes and the server
    // module keep the older name deliberately, so the words a human reads are
    // the one place the rename can regress without anything breaking.
    for (const kind of ['memory', 'skill', 'doc'] as const) {
      expect(acceptTarget(kind).label).not.toMatch(/harvest/i);
    }
    expect(suggestionProvenance(suggestionSetFromRow(row()))).not.toMatch(/harvest/i);
    expect(suggestionProvenance(suggestionSetFromRow(row({ reason: 'idle' })))).not.toMatch(/harvest/i);
  });

  it('admits that a skill becomes a document', () => {
    // There is no app-side skill store — agent_skill_documents is daemon-owned
    // and read-only — so a skill suggestion becomes a written page. The label
    // has to say so BEFORE the click, not explain it afterwards.
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
  it('says what became of the conversation, that a model wrote it, and that nothing is saved', () => {
    const text = suggestionProvenance(suggestionSetFromRow(row()));
    expect(text).toMatch(/Suggested by a model/);
    expect(text).toMatch(/the netlify thing/);
    expect(text).toMatch(/deleted/);
    expect(text).toMatch(/Nothing has been saved yet/);
  });

  it('never tells you a live conversation was deleted', () => {
    // The whole point of mining live chats is that the source is still there.
    // Reusing the deleted wording would send someone looking for a thread they
    // would then find, and doubt the rest of the card.
    const text = suggestionProvenance(suggestionSetFromRow(row({ reason: 'idle', session_deleted_at: null })));
    expect(text).toMatch(/went quiet/);
    expect(text).not.toMatch(/deleted/);
    expect(text).toMatch(/29 Jul 2026/);
    expect(text).toMatch(/Nothing has been saved yet/);
  });

  it('reads sensibly when the conversation had no title', () => {
    const text = suggestionProvenance(suggestionSetFromRow(row({ session_title: '' })));
    expect(text).toMatch(/an untitled conversation/);
    expect(text).not.toMatch(/""/);
  });

  it('never prints Invalid Date', () => {
    expect(formatSuggestionDate('')).toBe('an unknown date');
    expect(formatSuggestionDate('not-a-date')).toBe('an unknown date');
    expect(formatSuggestionDate('2026-07-29T09:00:00Z')).toMatch(/2026/);
  });
});

describe('flagging something the workspace already knows', () => {
  it('matches a memory suggestion against existing facts, ignoring casing and punctuation', () => {
    const suggestion = suggestionSetFromRow(row()).suggestions[0];
    expect(duplicateOf(suggestion, [fact('deploy from a clean clone')], [])).toEqual({
      kind: 'fact',
      label: 'deploy from a clean clone',
    });
    expect(duplicateOf(suggestion, [fact('Deploy from a dirty clone.')], [])).toBeNull();
    expect(duplicateOf(suggestion, [], [])).toBeNull();
  });

  it('matches a doc or skill suggestion on its title', () => {
    const docSuggestion = suggestionSetFromRow(row({ findings: [finding({ kind: 'doc', title: 'Why Two Backends' })] })).suggestions[0];
    expect(duplicateOf(docSuggestion, [], [doc('why two backends')])?.kind).toBe('document');
    expect(duplicateOf(docSuggestion, [], [doc('Something else')])).toBeNull();
  });

  it('flags the duplicate rather than hiding the suggestion', () => {
    // A silent filter would decide for the reader. reviewableSuggestionSets
    // knows nothing about existing memory, so a duplicate still renders — with
    // a warning.
    const set = suggestionSetFromRow(row());
    expect(reviewableSuggestionSets([set])).toHaveLength(1);
    expect(suggestionCounts(set.suggestions).pending).toBe(1);
  });
});

describe('what an answered suggestion reads as', () => {
  const parsed = (over: Record<string, unknown>) => suggestionFromRow(finding(over), 0) as Suggestion;

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

  it('is empty while a suggestion is still waiting', () => {
    expect(decisionSummary(parsed({}))).toBe('');
  });
});
