// What the Suggestions surface shows, decided here rather than in the panel.
//
// A conversation gets read once for what the workspace should KEEP from it — a
// repeatable procedure, a durable fact, a decision worth a written page. It is
// read when the thread is deleted, and again whenever a live one has gone quiet
// for a few hours. The model's answer is stored as SUGGESTIONS and NOTHING is
// written anywhere until a person accepts one. That last sentence is the whole
// design, and it is why this module never derives an "accept everything"
// affordance and never treats a suggestion as a fact.
//
// The server still calls this a "thread harvest" — the table, the routes and
// server/thread-harvest.cjs all keep that name, because renaming a live table
// two backends read buys nothing a human can see. This file is the boundary
// where the older word stops and the product's word starts, which is why the
// row type below is the only place both appear.
//
// Pure and dependency-free so the ordering, the dedup and the accept-target
// labels can be tested without mounting a window.

import type { Document, MemoryFact } from '../types';

/** What a suggestion is for. Mirrors HARVEST_KINDS in server/thread-harvest.cjs. */
export type SuggestionKind = 'skill' | 'memory' | 'doc';

/** A verdict a person has recorded. '' means still waiting on someone. */
export type SuggestionDecision = 'accepted' | 'dismissed' | '';

/**
 * Why a conversation was read. Mirrors the `reason` column.
 *
 * The two are not interchangeable on screen: 'deleted' means the source is gone
 * and cannot be checked, 'idle' means it is still there to open.
 */
export type SuggestionReason = 'deleted' | 'idle' | string;

export interface Suggestion {
  /** Position in the stored array — the id the accept route takes. */
  index: number;
  kind: SuggestionKind;
  title: string;
  body: string;
  /** One sentence from the model on why this is worth keeping. Often empty. */
  why: string;
  decision: SuggestionDecision;
  decidedAt: string;
  decidedByName: string;
  /** Where an accepted suggestion landed, once it has. */
  targetTable: string;
  targetId: string;
}

/** Everything one reading of one conversation suggested. */
export interface SuggestionSet {
  id: string;
  workspaceId: string;
  sessionId: string;
  status: string;
  reason: SuggestionReason;
  suggestions: Suggestion[];
  createdAt: string;
  /** The conversation's title, or '' if it has since gone entirely. */
  threadTitle: string;
  /** When it was deleted, or '' when it is still there and merely went quiet. */
  discardedAt: string;
  /** When this reading happened. Always present; discardedAt may not be. */
  reviewedAt: string;
}

/** The raw `thread_harvests` row, as the route and the realtime feed send it. */
export interface SuggestionSetRow {
  id: string;
  workspace_id: string;
  session_id: string;
  status?: string | null;
  reason?: string | null;
  findings?: unknown;
  created_at?: string | null;
  session_title?: string | null;
  session_deleted_at?: string | null;
}

const KINDS: SuggestionKind[] = ['skill', 'memory', 'doc'];

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One stored suggestion, normalised.
 *
 * Returns null for anything that is not a recognisable suggestion. The server
 * already drops malformed ones before storing them, so this is the second line
 * of the same rule: a half-parsed suggestion put in front of a human as
 * something to accept is worse than one fewer suggestion.
 */
export function suggestionFromRow(raw: unknown, index: number): Suggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const kind = text(entry.kind).trim().toLowerCase() as SuggestionKind;
  if (!KINDS.includes(kind)) return null;
  const title = text(entry.title).trim();
  const body = text(entry.body).trim();
  if (!title || !body) return null;
  const decision = text(entry.decision).trim().toLowerCase();
  return {
    index,
    kind,
    title,
    body,
    why: text(entry.why).trim(),
    decision: decision === 'accepted' || decision === 'dismissed' ? decision : '',
    decidedAt: text(entry.decided_at),
    decidedByName: text(entry.decided_by_name),
    targetTable: text(entry.target_table),
    targetId: text(entry.target_id),
  };
}

/**
 * A stored row, normalised.
 *
 * The index is taken from the RAW array position, not from the filtered list, so
 * dropping an unrecognisable suggestion cannot shift the id of the ones after it
 * and make a click accept the wrong one.
 */
export function suggestionSetFromRow(row: SuggestionSetRow): SuggestionSet {
  const raw = Array.isArray(row.findings) ? row.findings : [];
  const suggestions: Suggestion[] = [];
  raw.forEach((entry, index) => {
    const suggestion = suggestionFromRow(entry, index);
    if (suggestion) suggestions.push(suggestion);
  });
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    status: text(row.status) || 'done',
    reason: text(row.reason) || 'deleted',
    suggestions,
    createdAt: text(row.created_at),
    threadTitle: text(row.session_title).trim(),
    discardedAt: text(row.session_deleted_at),
    reviewedAt: text(row.created_at),
  };
}

export interface SuggestionCounts {
  total: number;
  pending: number;
  accepted: number;
  dismissed: number;
}

export function suggestionCounts(suggestions: readonly Suggestion[]): SuggestionCounts {
  let accepted = 0;
  let dismissed = 0;
  for (const suggestion of suggestions) {
    if (suggestion.decision === 'accepted') accepted += 1;
    else if (suggestion.decision === 'dismissed') dismissed += 1;
  }
  return {
    total: suggestions.length,
    pending: suggestions.length - accepted - dismissed,
    accepted,
    dismissed,
  };
}

/** Every suggestion across every conversation that still needs a person. */
export function pendingSuggestionCount(sets: readonly SuggestionSet[]): number {
  return sets.reduce((total, set) => total + suggestionCounts(set.suggestions).pending, 0);
}

/**
 * Review order: sets with something outstanding first, newest first inside each
 * group.
 *
 * Answered sets are kept rather than dropped — the answer is the record of where
 * a fact in memory came from, and a list that empties itself the moment you
 * click gives no way back to check what you just accepted.
 */
export function sortSuggestionSets(sets: readonly SuggestionSet[]): SuggestionSet[] {
  return [...sets].sort((a, b) => {
    const aPending = suggestionCounts(a.suggestions).pending > 0 ? 0 : 1;
    const bPending = suggestionCounts(b.suggestions).pending > 0 ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

/** Sets worth listing at all: ones that actually suggested something. */
export function reviewableSuggestionSets(sets: readonly SuggestionSet[]): SuggestionSet[] {
  return sortSuggestionSets(sets.filter(set => set.suggestions.length > 0));
}

export interface AcceptTarget {
  /** Which store accepting writes into. */
  table: 'memory_facts' | 'documents';
  /** Said on the button's own line, BEFORE the click, never after. */
  label: string;
}

/**
 * Where accepting writes. Mirrors harvestAcceptTarget in
 * server/thread-harvest.cjs — the server decides, this only has to say so.
 *
 * A "skill" becomes a DOCUMENT, and the label says so plainly. A skill in this
 * product is a SKILL.md a daemon owns on its own disk and mirrors up read-only,
 * so there is no app-side skill store to accept into; a written page is the
 * honest landing place and the person clicking deserves to know that first.
 * The folder is "Playbooks", not "Skills" — the old name implied this WAS the
 * real skill registry, which is exactly the mistake the label is trying to avoid.
 */
export function acceptTarget(kind: SuggestionKind): AcceptTarget {
  if (kind === 'memory') return { table: 'memory_facts', label: 'Team memory' };
  if (kind === 'skill') return { table: 'documents', label: 'Documents · Playbooks' };
  return { table: 'documents', label: 'Documents · Suggestions' };
}

/** The word for a kind on a chip. Never an emoji. */
export function kindLabel(kind: SuggestionKind): string {
  if (kind === 'memory') return 'Memory';
  if (kind === 'skill') return 'Skill';
  return 'Doc';
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Is this suggestion already in the workspace?
 *
 * The server drops a suggestion it has proposed BEFORE, so repeats across
 * conversations never reach this screen. This catches the other overlap: a fact
 * or page that got into the workspace some other way — somebody typed it — which
 * the stored history knows nothing about.
 *
 * The duplicate is SHOWN, not hidden and not auto-dismissed: the reader decides,
 * and a near-miss they can see beats a silent filter they cannot.
 *
 * Compares on normalised text because a model rewrites punctuation and casing
 * freely while saying the same thing.
 */
export function duplicateOf(
  suggestion: Suggestion,
  facts: readonly MemoryFact[],
  documents: readonly Document[],
): { kind: 'fact' | 'document'; label: string } | null {
  if (suggestion.kind === 'memory') {
    const target = normalizeForCompare(suggestion.body);
    if (!target) return null;
    const match = facts.find(fact => normalizeForCompare(fact.fact) === target);
    return match ? { kind: 'fact', label: match.fact } : null;
  }
  const target = normalizeForCompare(suggestion.title);
  if (!target) return null;
  const match = documents.find(document => normalizeForCompare(document.title) === target);
  return match ? { kind: 'document', label: match.title } : null;
}

/**
 * The provenance line under a set's heading.
 *
 * Says all three things at once, because each on its own is misleading: WHICH
 * conversation and what became of it, that a MODEL wrote this (so it can be
 * wrong), and that NOTHING has been written yet (so the list is a queue, not a
 * record of what happened).
 *
 * The two reasons get different wording on purpose. "Deleted" means the source
 * is gone and cannot be checked; "went quiet" means it is still there to open,
 * and telling somebody their live conversation was deleted would be a small lie
 * with a large jolt attached.
 */
export function suggestionProvenance(set: SuggestionSet): string {
  const title = set.threadTitle ? `"${set.threadTitle}"` : 'an untitled conversation';
  if (set.reason === 'idle') {
    return `Suggested by a model from ${title}, read on ${formatSuggestionDate(set.reviewedAt)}`
      + ' after it went quiet. Nothing has been saved yet.';
  }
  const verb = set.reason === 'cleared' ? 'cleared' : 'deleted';
  const when = set.discardedAt || set.reviewedAt;
  return `Suggested by a model from ${title}, ${verb} on ${formatSuggestionDate(when)}.`
    + ' Nothing has been saved yet.';
}

/** A date a person can read. '' rather than "Invalid Date" when it is missing. */
export function formatSuggestionDate(value: string): string {
  if (!value) return 'an unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What an already-answered suggestion reads as. */
export function decisionSummary(suggestion: Suggestion): string {
  if (!suggestion.decision) return '';
  const who = suggestion.decidedByName ? ` by ${suggestion.decidedByName}` : '';
  const when = suggestion.decidedAt ? ` on ${formatSuggestionDate(suggestion.decidedAt)}` : '';
  if (suggestion.decision === 'dismissed') return `Dismissed${who}${when}`;
  const where = suggestion.targetTable === 'memory_facts' ? ' into team memory'
    : suggestion.targetTable === 'documents' ? ' as a document'
      : '';
  return `Accepted${who}${when}${where}`;
}
