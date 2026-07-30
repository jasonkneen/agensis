import type { AgentConnection, ChatSession, WorkspaceAgent } from '../types';
import { agentAccentColor, agentHandle } from './agentAccent';
import { skillAgentInitials } from './skillsView';
import { parseParticipants, participantAgentKey } from './sessionParticipants';

// ---------------------------------------------------------------------------
// "Who should be in #incidents?" — answered from the channel NAME, locally.
//
// Every input this needs is already in the browser before the dialog opens:
// `agents` (useAgents), `agentConnections` (useAgentConnections) and `sessions`
// (useChat). So a suggestion costs ZERO network requests, ZERO model tokens and
// zero dollars, and it lands within one frame of the keystroke.
//
// The ranking is IDF-weighted lexical matching over five agent text fields.
// That is a deliberate choice over the obvious alternative — asking a model —
// and the reason is not only cost:
//
//   A lexical score can EXPLAIN itself. Every suggestion carries the token it
//   matched and the field it matched in, so the UI renders "skill:
//   incident-response" rather than asking the user to trust a ranking they
//   cannot see. A suggestion nobody can audit is worse than no suggestion,
//   because the cost of a wrong one is an agent silently joining a room and
//   answering in it (server/index.cjs continueConversation dispatches to the
//   participant roster).
//
// A model call was not rejected forever, and the seam for one is already here:
// this function is pure, ranked and scored, so a v2 can ask for `limit: 10`,
// reorder the shortlist with one debounced call, and show the top 5 — without
// touching the UI or this file. RERANKING a shortlist is both cheaper and safer
// than generating one. Whatever does it must stay non-blocking: the gateway
// being down has to degrade to this ranking, never to an empty panel.
// ---------------------------------------------------------------------------

/**
 * Where a matched token came from. The order of these is the order of trust,
 * and the weights below follow it.
 *
 * `advertised` vs `configured` is the same distinction src/lib/skillsView.ts
 * draws and for the same reason: a live daemon reporting a skill demonstrably
 * has it, while a skill typed into an offline agent's form is a claim nobody
 * has checked. Reused rather than reinvented so the two surfaces cannot drift.
 */
export type SuggestionField =
  /** `capabilities.skills[]` on a non-offline connection. The only evidence-backed source. */
  | 'advertised'
  /** `skills[]` on the agent row. A deliberate human claim. */
  | 'configured'
  /** The agent's name or handle. */
  | 'identity'
  /** The agent's one-line description. */
  | 'summary'
  /**
   * `tools[]` on the agent row. Weighted LOW on purpose: the column gates
   * nothing. The builtin lane builds its tool list from `toolset.specs(...)`
   * (server/builtin-turn.cjs), never from this column, and server-side it is
   * only ever interpolated into a prompt as "Available tool preferences: …".
   * Matching on it matches a label a human typed, not a capability — so it
   * contributes signal but can never outrank a real declared skill, and its
   * chip must never use capability wording. Both are pinned by tests.
   */
  | 'advisory'
  /** `system_prompt` + `instructions`, truncated. Long, and length is not evidence. */
  | 'prompt';

/**
 * Field weights. Ratios are what matter, not absolute values.
 *
 * `advisory` (0.8) sits below `configured` (2.0) so a tools[] hit can never
 * beat a skills[] hit on the same token — the whole point of separating them.
 * `prompt` (0.6) is lowest because prompt text is the least deliberate signal
 * and the most abundant.
 */
export const FIELD_WEIGHTS: Record<SuggestionField, number> = {
  advertised: 3.0,
  identity: 2.5,
  configured: 2.0,
  summary: 1.5,
  advisory: 0.8,
  prompt: 0.6,
};

/**
 * How much of `system_prompt` + `instructions` is indexed.
 *
 * A 4 KB prompt would otherwise put hundreds of tokens into the bag and match
 * almost any channel name — winning on volume rather than on fit. Truncating
 * caps a verbose agent's reach at roughly that of a description. This is the
 * only thing stopping "the agent with the longest prompt is suggested for
 * everything", and a test asserts a token that appears only past this cutoff
 * does not match.
 */
export const PROMPT_INDEX_CHARS = 400;

/** A prefix hit scores half an exact hit, and only for query tokens this long. */
export const MIN_PREFIX_QUERY_LENGTH = 3;
const PREFIX_MULTIPLIER = 0.5;

/** Bonus ceilings. These only ever REORDER agents that already matched the name. */
const PRIOR_WEIGHT = 0.35;
const AFFINITY_WEIGHT = 0.30;
const LIVENESS_WEIGHT = 0.15;

/** How many suggestions the UI asks for. */
export const SUGGESTION_LIMIT = 5;

/**
 * Words that carry no signal in ANY workspace. Deliberately tiny: IDF already
 * neutralizes workspace-specific boilerplate ("you are a helpful agent") by
 * measuring it, which is strictly better than a list somebody has to maintain.
 * This exists only to keep the index small, not to do the discriminating.
 */
const STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'are', 'with', 'that', 'this', 'from', 'your',
  'have', 'has', 'not', 'but', 'can', 'will', 'when', 'what', 'who', 'all',
  'any', 'use', 'used', 'using', 'into', 'onto', 'its', 'their', 'them',
  'they', 'was', 'were', 'been', 'being', 'than', 'then', 'there', 'here',
]);

export interface SuggestionReason {
  field: SuggestionField | 'prior';
  /** The matched token, or '' for a prior-only suggestion. */
  token: string;
  /** Exactly what the chip shows. Derived from the score, never narrated beside it. */
  label: string;
}

export interface MemberSuggestion {
  agentId: string;
  name: string;
  handle: string;
  /** Chip identity: initials on a solid colour. NEVER an emoji — house rule. */
  initials: string;
  color: string;
  score: number;
  /**
   * TRUE when the channel name matched this agent's text at all. False means
   * this is a fallback ("here are the agents you use most"), which the UI must
   * LABEL as such rather than present as a match.
   */
  matched: boolean;
  connected: boolean;
  reason: SuggestionReason;
}

/** Lowercase alphanumeric tokens, stopwords and 1-char noise dropped. */
export function tokenize(value: unknown): string[] {
  if (value == null) return [];
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(token => token.length >= 2 && !STOPWORDS.has(token));
}

interface AgentEntry {
  agentId: string;
  name: string;
  handle: string;
  initials: string;
  color: string;
  connected: boolean;
  /** token -> the highest field weight that token appears at for this agent. */
  weights: Map<string, number>;
  /** token -> the field that produced that highest weight, for the reason chip. */
  fields: Map<string, SuggestionField>;
}

export interface SuggestionIndex {
  entries: AgentEntry[];
  byId: Map<string, AgentEntry>;
  /** token -> agents carrying it. The inverted index: scoring never scans all agents. */
  postings: Map<string, AgentEntry[]>;
  /** Every indexed token, sorted, so a prefix range is a binary search not a scan. */
  sortedTokens: string[];
  idf: Map<string, number>;
  channelCount: Map<string, number>;
  maxChannelCount: number;
  coMembership: Map<string, Map<string, number>>;
}

function addToken(entry: AgentEntry, token: string, field: SuggestionField) {
  const weight = FIELD_WEIGHTS[field];
  const existing = entry.weights.get(token);
  if (existing !== undefined && existing >= weight) return;
  entry.weights.set(token, weight);
  entry.fields.set(token, field);
}

function addTokens(entry: AgentEntry, value: unknown, field: SuggestionField) {
  for (const token of tokenize(value)) addToken(entry, token, field);
}

function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(item => String(item ?? '').trim()).filter(Boolean);
}

/**
 * A channel for co-membership and "how many channels is this agent in" purposes.
 *
 * DMs are excluded because EVERY agent has one, so they carry no information —
 * counting them would rank agents by how many direct messages exist, which is a
 * constant. Sub-threads, huddle transcripts and soft-deleted rows are excluded
 * for the same reason `mainSessionsOf` excludes them: they are not rooms a
 * person chose to put someone in.
 */
function isRankableChannel(session: ChatSession): boolean {
  if (session.deleted_at) return false;
  if (session.parent_message_id) return false;
  if (String(session.folder || '') === 'Direct messages') return false;
  return true;
}

/**
 * The expensive half, memoized by the caller on [agents, connections, sessions].
 * It does NOT depend on the channel name, so it never runs per keystroke.
 */
export function buildSuggestionIndex(
  agents: readonly WorkspaceAgent[],
  connections: readonly AgentConnection[],
  sessions: readonly ChatSession[],
): SuggestionIndex {
  const connByKey = new Map<string, AgentConnection>();
  for (const conn of connections) {
    if (conn.status === 'offline') continue;
    if (conn.agent_id) connByKey.set(String(conn.agent_id).toLowerCase(), conn);
    if (conn.handle) connByKey.set(String(conn.handle).toLowerCase(), conn);
  }

  const entries: AgentEntry[] = [];
  const byId = new Map<string, AgentEntry>();

  for (const agent of agents) {
    // A disabled agent cannot answer, so suggesting it would be suggesting
    // silence. Same filter buildSkillEntries applies.
    if (agent.enabled === false) continue;
    const handle = agentHandle(agent);
    const conn = connByKey.get(String(agent.id).toLowerCase())
      || connByKey.get(String(agent.handle || '').toLowerCase());

    const entry: AgentEntry = {
      agentId: String(agent.id),
      name: agent.name || handle,
      handle,
      initials: skillAgentInitials(agent),
      color: agentAccentColor(agent),
      connected: Boolean(conn),
      weights: new Map(),
      fields: new Map(),
    };

    // Highest-trust first is not required (addToken keeps the max) but it makes
    // the intent readable, and it makes the `fields` tie-break deterministic.
    for (const skill of normalizeList(conn?.capabilities?.skills)) {
      addTokens(entry, skill, 'advertised');
    }
    addTokens(entry, agent.name, 'identity');
    addTokens(entry, handle, 'identity');
    for (const skill of normalizeList(agent.skills)) addTokens(entry, skill, 'configured');
    addTokens(entry, agent.description, 'summary');
    for (const tool of normalizeList(agent.tools)) addTokens(entry, tool, 'advisory');
    addTokens(
      entry,
      `${agent.system_prompt || ''} ${agent.instructions || ''}`.slice(0, PROMPT_INDEX_CHARS),
      'prompt',
    );

    entries.push(entry);
    byId.set(entry.agentId, entry);
  }

  // --- inverted index + IDF ------------------------------------------------
  const postings = new Map<string, AgentEntry[]>();
  for (const entry of entries) {
    for (const token of entry.weights.keys()) {
      const list = postings.get(token);
      if (list) list.push(entry);
      else postings.set(token, [entry]);
    }
  }

  // BM25-shaped IDF rather than plain log(N/df). Two properties earn it:
  // a token every agent carries decays to ~0.1 instead of the ~0.6 the naive
  // form leaves behind (which is enough to still swing a ranking), and the
  // +0.5 terms keep it strictly positive, so a common token can never subtract
  // from a score and push a genuine match below an agent that matched nothing.
  const total = entries.length;
  const idf = new Map<string, number>();
  for (const [token, list] of postings) {
    const df = list.length;
    idf.set(token, Math.log(1 + (total - df + 0.5) / (df + 0.5)));
  }

  const sortedTokens = Array.from(postings.keys()).sort();

  // --- priors from real channel membership ---------------------------------
  const channelCount = new Map<string, number>();
  const coMembership = new Map<string, Map<string, number>>();
  for (const session of sessions) {
    if (!isRankableChannel(session)) continue;
    const memberIds: string[] = [];
    for (const participant of parseParticipants(session.participants)) {
      const key = participantAgentKey(participant);
      if (key && byId.has(key)) memberIds.push(key);
    }
    const unique = Array.from(new Set(memberIds));
    for (const id of unique) channelCount.set(id, (channelCount.get(id) ?? 0) + 1);
    for (const a of unique) {
      let row = coMembership.get(a);
      if (!row) { row = new Map(); coMembership.set(a, row); }
      for (const b of unique) {
        if (a === b) continue;
        row.set(b, (row.get(b) ?? 0) + 1);
      }
    }
  }
  let maxChannelCount = 0;
  for (const count of channelCount.values()) maxChannelCount = Math.max(maxChannelCount, count);

  return { entries, byId, postings, sortedTokens, idf, channelCount, maxChannelCount, coMembership };
}

/** First index whose token is >= `target`. */
function lowerBound(sorted: readonly string[], target: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface SuggestOptions {
  /** Agents already chosen. Drives the affinity boost and is excluded from results. */
  selectedAgentIds?: readonly string[];
  limit?: number;
}

/**
 * The hot path — runs on every keystroke, and is the only thing that does.
 *
 * Two-tier ordering, and the tiers are the load-bearing part: an agent that
 * matched the NAME always outranks one that did not, whatever its bonuses.
 * Expressing that as a tier rather than as arithmetic is deliberate — with a
 * purely additive score, a weak match (a common token in a prompt) can score
 * below a strong prior, and an always-online agent in a dozen channels would
 * quietly outrank the offline agent whose declared skill IS the channel's
 * subject. That is the single most damaging way this feature can be wrong.
 */
export function suggestChannelMembers(
  index: SuggestionIndex,
  channelName: string,
  options: SuggestOptions = {},
): MemberSuggestion[] {
  const limit = options.limit ?? SUGGESTION_LIMIT;
  const selected = new Set(options.selectedAgentIds ?? []);
  const queryTokens = Array.from(new Set(tokenize(channelName)));

  const lexical = new Map<string, number>();
  const best = new Map<string, { field: SuggestionField; token: string; contribution: number }>();

  for (const token of queryTokens) {
    const weight = index.idf.get(token) ?? 0;

    // Exact hits.
    for (const entry of index.postings.get(token) ?? []) {
      const contribution = weight * (entry.weights.get(token) ?? 0);
      if (contribution <= 0) continue;
      lexical.set(entry.agentId, (lexical.get(entry.agentId) ?? 0) + contribution);
      const current = best.get(entry.agentId);
      if (!current || contribution > current.contribution) {
        best.set(entry.agentId, {
          field: entry.fields.get(token) ?? 'prompt',
          token,
          contribution,
        });
      }
    }

    // Prefix hits: "#deploy" should reach an agent whose skill is
    // "deployment-manager". Half weight, so it can never beat the exact match
    // it is standing in for.
    if (token.length < MIN_PREFIX_QUERY_LENGTH) continue;
    for (let i = lowerBound(index.sortedTokens, token); i < index.sortedTokens.length; i += 1) {
      const candidate = index.sortedTokens[i];
      if (!candidate.startsWith(token)) break;
      if (candidate === token) continue;
      const candidateIdf = index.idf.get(candidate) ?? 0;
      for (const entry of index.postings.get(candidate) ?? []) {
        const contribution = candidateIdf * (entry.weights.get(candidate) ?? 0) * PREFIX_MULTIPLIER;
        if (contribution <= 0) continue;
        lexical.set(entry.agentId, (lexical.get(entry.agentId) ?? 0) + contribution);
        const current = best.get(entry.agentId);
        if (!current || contribution > current.contribution) {
          best.set(entry.agentId, {
            field: entry.fields.get(candidate) ?? 'prompt',
            token: candidate,
            contribution,
          });
        }
      }
    }
  }

  // Affinity is normalized against the strongest pair in THIS selection, so it
  // stays a 0..1 nudge whether the workspace has three channels or three hundred.
  const affinityRaw = new Map<string, number>();
  let maxAffinity = 0;
  if (selected.size > 0) {
    for (const entry of index.entries) {
      if (selected.has(entry.agentId)) continue;
      let shared = 0;
      for (const selectedId of selected) {
        shared += index.coMembership.get(selectedId)?.get(entry.agentId) ?? 0;
      }
      if (shared > 0) {
        affinityRaw.set(entry.agentId, shared);
        maxAffinity = Math.max(maxAffinity, shared);
      }
    }
  }

  const priorDenominator = Math.log1p(index.maxChannelCount);

  const scored = index.entries
    .filter(entry => !selected.has(entry.agentId))
    .map(entry => {
      const lex = lexical.get(entry.agentId) ?? 0;
      const prior = priorDenominator > 0
        ? Math.log1p(index.channelCount.get(entry.agentId) ?? 0) / priorDenominator
        : 0;
      const affinity = maxAffinity > 0 ? (affinityRaw.get(entry.agentId) ?? 0) / maxAffinity : 0;
      const liveness = entry.connected ? 1 : 0;
      const matched = lex > 0;
      // Bonuses apply in BOTH tiers. They can be uniform precisely because the
      // tier — not the arithmetic — is what stops a popular agent outranking a
      // relevant one, and applying them uniformly is what lets affinity work in
      // the no-match fallback, where "who usually goes with the people you just
      // picked" is the only signal left.
      const score = lex
        + PRIOR_WEIGHT * prior
        + AFFINITY_WEIGHT * affinity
        + LIVENESS_WEIGHT * liveness;
      const hit = best.get(entry.agentId);
      const reason: SuggestionReason = matched && hit
        ? { field: hit.field, token: hit.token, label: reasonLabel(hit.field, hit.token, entry.handle) }
        : {
          field: 'prior',
          token: '',
          label: priorLabel(index.channelCount.get(entry.agentId) ?? 0),
        };
      return {
        agentId: entry.agentId,
        name: entry.name,
        handle: entry.handle,
        initials: entry.initials,
        color: entry.color,
        score,
        matched,
        connected: entry.connected,
        reason,
      } satisfies MemberSuggestion;
    });

  // Ties break by name so the same inputs always produce the same order — a
  // list that reshuffles between renders reads as broken even when it is not.
  scored.sort((a, b) => {
    if (a.matched !== b.matched) return a.matched ? -1 : 1;
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  // Nothing matched the name at all: fall back to the agents this workspace
  // actually puts in channels. A defensible default beats an empty panel — but
  // `matched: false` travels with it so the UI can say which one this is.
  return scored.slice(0, limit);
}

/**
 * The chip text, derived from the winning field.
 *
 * `advertised` is the ONLY wording that asserts capability, and only a live
 * daemon earns it. `configured` and `advisory` share the hedged "lists:" form:
 * both are things a human typed, and `tools[]` in particular gates nothing at
 * all, so a chip implying otherwise would be the UI asserting something false.
 * Pinned by a test.
 */
export function reasonLabel(field: SuggestionField, token: string, handle: string): string {
  switch (field) {
    case 'advertised': return `skill: ${token}`;
    case 'configured': return `lists: ${token}`;
    case 'advisory': return `lists: ${token}`;
    case 'identity': return `@${handle}`;
    case 'summary':
    case 'prompt': return `mentions "${token}"`;
  }
}

function priorLabel(count: number): string {
  if (count <= 0) return 'in no channels yet';
  return `in ${count} channel${count === 1 ? '' : 's'}`;
}
