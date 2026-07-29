// What the harvest review surface shows, decided here rather than in the panel.
//
// Deleting a chat thread queues a background analysis of what the workspace
// should KEEP from it — a repeatable procedure, a durable fact, a decision worth
// a written page. The model's answer is stored as PROPOSALS on `thread_harvests`
// and NOTHING is written anywhere until a person accepts one. That last sentence
// is the whole design, and it is why this module never derives an "accept
// everything" affordance and never treats a proposal as a fact.
//
// Pure and dependency-free so the ordering, the dedup and the accept-target
// labels can be tested without mounting a window.

import type { Document, MemoryFact } from '../types';

/** What a proposal is for. Mirrors HARVEST_KINDS in server/thread-harvest.cjs. */
export type HarvestKind = 'skill' | 'memory' | 'doc';

/** A verdict a person has recorded. '' means still waiting on someone. */
export type HarvestDecision = 'accepted' | 'dismissed' | '';

export interface HarvestFinding {
  /** Position in the harvest's findings array — the id the accept route takes. */
  index: number;
  kind: HarvestKind;
  title: string;
  body: string;
  /** One sentence from the model on why this is worth keeping. Often empty. */
  why: string;
  decision: HarvestDecision;
  decidedAt: string;
  decidedByName: string;
  /** Where an accepted proposal landed, once it has. */
  targetTable: string;
  targetId: string;
}

export interface ThreadHarvest {
  id: string;
  workspaceId: string;
  sessionId: string;
  status: string;
  /** Why the thread went away. 'deleted' today; the column allows more. */
  reason: string;
  findings: HarvestFinding[];
  createdAt: string;
  /** The discarded thread's title, or '' if the thread has since gone entirely. */
  threadTitle: string;
  /** When the thread was discarded. Falls back to when the harvest was queued. */
  discardedAt: string;
}

/** The raw `thread_harvests` row, as the route and the realtime feed send it. */
export interface ThreadHarvestRow {
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

const KINDS: HarvestKind[] = ['skill', 'memory', 'doc'];

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * One stored finding, normalised.
 *
 * Returns null for anything that is not a recognisable proposal. The server
 * already drops malformed findings before storing them, so this is the second
 * line of the same rule: a half-parsed suggestion put in front of a human as
 * something to accept is worse than one fewer suggestion.
 */
export function harvestFindingFromRow(raw: unknown, index: number): HarvestFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Record<string, unknown>;
  const kind = text(entry.kind).trim().toLowerCase() as HarvestKind;
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
 * A harvest row, normalised.
 *
 * The index is taken from the RAW array position, not from the filtered list, so
 * dropping an unrecognisable finding cannot shift the id of the ones after it
 * and make a click accept the wrong proposal.
 */
export function harvestFromRow(row: ThreadHarvestRow): ThreadHarvest {
  const raw = Array.isArray(row.findings) ? row.findings : [];
  const findings: HarvestFinding[] = [];
  raw.forEach((entry, index) => {
    const finding = harvestFindingFromRow(entry, index);
    if (finding) findings.push(finding);
  });
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    status: text(row.status) || 'done',
    reason: text(row.reason) || 'deleted',
    findings,
    createdAt: text(row.created_at),
    threadTitle: text(row.session_title).trim(),
    discardedAt: text(row.session_deleted_at) || text(row.created_at),
  };
}

export interface HarvestCounts {
  total: number;
  pending: number;
  accepted: number;
  dismissed: number;
}

export function harvestCounts(findings: readonly HarvestFinding[]): HarvestCounts {
  let accepted = 0;
  let dismissed = 0;
  for (const finding of findings) {
    if (finding.decision === 'accepted') accepted += 1;
    else if (finding.decision === 'dismissed') dismissed += 1;
  }
  return { total: findings.length, pending: findings.length - accepted - dismissed, accepted, dismissed };
}

/** Every proposal across every harvest that still needs a person. */
export function pendingProposalCount(harvests: readonly ThreadHarvest[]): number {
  return harvests.reduce((total, harvest) => total + harvestCounts(harvest.findings).pending, 0);
}

/**
 * Review order: harvests with something outstanding first, newest first inside
 * each group.
 *
 * Answered harvests are kept rather than dropped — the answer is the record of
 * where a fact in memory came from, and a list that empties itself the moment
 * you click gives no way back to check what you just accepted.
 */
export function sortHarvests(harvests: readonly ThreadHarvest[]): ThreadHarvest[] {
  return [...harvests].sort((a, b) => {
    const aPending = harvestCounts(a.findings).pending > 0 ? 0 : 1;
    const bPending = harvestCounts(b.findings).pending > 0 ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

/** Harvests worth listing at all: ones that actually proposed something. */
export function reviewableHarvests(harvests: readonly ThreadHarvest[]): ThreadHarvest[] {
  return sortHarvests(harvests.filter(harvest => harvest.findings.length > 0));
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
 */
export function acceptTarget(kind: HarvestKind): AcceptTarget {
  if (kind === 'memory') return { table: 'memory_facts', label: 'Team memory' };
  if (kind === 'skill') return { table: 'documents', label: 'Documents · Skills' };
  return { table: 'documents', label: 'Documents · Harvested' };
}

/** The word for a kind on a chip. Never an emoji. */
export function kindLabel(kind: HarvestKind): string {
  if (kind === 'memory') return 'Memory';
  if (kind === 'skill') return 'Skill';
  return 'Doc';
}

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Is this proposal already in the workspace?
 *
 * A discarded thread often repeats what the workspace already knows, and the
 * review surface is the last place to catch that — once accepted it is a second
 * copy of a fact, indistinguishable from the first and just as trusted. So the
 * duplicate is SHOWN, not hidden and not auto-dismissed: the reader decides, and
 * a near-miss they can see beats a silent filter they cannot.
 *
 * Compares on normalised text because a model rewrites punctuation and casing
 * freely while saying the same thing.
 */
export function duplicateOf(
  finding: HarvestFinding,
  facts: readonly MemoryFact[],
  documents: readonly Document[],
): { kind: 'fact' | 'document'; label: string } | null {
  if (finding.kind === 'memory') {
    const target = normalizeForCompare(finding.body);
    if (!target) return null;
    const match = facts.find(fact => normalizeForCompare(fact.fact) === target);
    return match ? { kind: 'fact', label: match.fact } : null;
  }
  const target = normalizeForCompare(finding.title);
  if (!target) return null;
  const match = documents.find(document => normalizeForCompare(document.title) === target);
  return match ? { kind: 'document', label: match.title } : null;
}

/**
 * The provenance line under a harvest's heading.
 *
 * Says all three things at once, because each on its own is misleading: the
 * thread is GONE (so nobody can go and read the source), a MODEL wrote this (so
 * it can be wrong), and NOTHING has been written yet (so the list is a queue,
 * not a record of what happened).
 */
export function harvestProvenance(harvest: ThreadHarvest): string {
  const title = harvest.threadTitle ? `"${harvest.threadTitle}"` : 'an untitled thread';
  const verb = harvest.reason === 'cleared' ? 'cleared' : 'deleted';
  return `Proposed by a model from ${title}, ${verb} on ${formatHarvestDate(harvest.discardedAt)}. Nothing has been saved yet.`;
}

/** A date a person can read. '' rather than "Invalid Date" when it is missing. */
export function formatHarvestDate(value: string): string {
  if (!value) return 'an unknown date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'an unknown date';
  return date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/** What an already-answered proposal reads as. */
export function decisionSummary(finding: HarvestFinding): string {
  if (!finding.decision) return '';
  const who = finding.decidedByName ? ` by ${finding.decidedByName}` : '';
  const when = finding.decidedAt ? ` on ${formatHarvestDate(finding.decidedAt)}` : '';
  if (finding.decision === 'dismissed') return `Dismissed${who}${when}`;
  const where = finding.targetTable === 'memory_facts' ? ' into team memory'
    : finding.targetTable === 'documents' ? ' as a document'
      : '';
  return `Accepted${who}${when}${where}`;
}
