'use strict';

// ---------------------------------------------------------------------------
// AMBIENT ADDRESSING — who answers a channel post that named nobody.
//
// The un-addressed case already dispatched before this file existed: one cheap
// Haiku call (pickAutoInterjectWatcher) elects a single agent or null. What was
// missing is the case that dominates real traffic — a human replying to the
// agent that just spoke. That was a paid, non-deterministic call deciding
// something the transcript already states, and it could route wrong.
//
// This module is the FREE tier in front of that call:
//
//   openInterlocutor      — the agent you are demonstrably mid-conversation
//                           with, decided from the messages already in hand.
//   isStructurallyTrivial — a cold post with no letters and no digits is not
//                           worth a model call.
//   isHumanAuthored       — only a PERSON opens an ambient election.
//   ambientRepliesEnabled — the per-agent off switch.
//
// EVERY EXPORT HERE IS A SUPPRESSOR OR A SUBSTITUTION. openInterlocutor elects
// at most one agent, and only ever one the paid call could itself have elected
// (continueConversation passes it the same candidate pool). Nothing here can
// turn a "no agent" into a "yes". That is what keeps the loop bound intact:
// the set of messages that dispatch is a subset of what dispatched before.
//
// NO DATABASE, NO MODEL, NO CLOCK. Every input is passed in — including
// `nowMs`, because a TTL read from Date.now() inside the function is a test
// that either sleeps or lies (shared/replyCadence.cjs derives its jitter from
// the message id for the same reason).
//
// SERVER-ONLY, deliberately: there is NO src/lib twin and NO parity fixture.
// The three modules that have twins (channelMentions, channelIntent,
// replyCadence) have them because a UI surface must state the same answer — the
// composer quotes mention parsing, the Edit Channel dialog quotes the cadence
// timings. Ambient election has no such surface: nothing in the browser
// predicts who will pick a message up. A twin would be a permanent drift
// liability for zero user-visible benefit. If a composer hint ever lands
// ("Scout will pick this up"), that is when the twin and its fixture get built.
// ---------------------------------------------------------------------------

const { parseMentionHandles } = require('./channelMentions.cjs');

/**
 * How long an exchange stays "live" — measured from the agent's last message,
 * not from the human's.
 *
 * Ten minutes, anchored to numbers already in this repo rather than picked from
 * the air: a single agent turn may legitimately run for minutes
 * (AGENT_JOB_IDLE_REAP_MINUTES is 10), and reading a reply then typing a
 * follow-up is a seconds-to-minutes act. Past that the paid router, which reads
 * actual context, is a better judge than a pointer into a cold transcript.
 */
const CONTINUITY_TTL_MS = 10 * 60 * 1000;

/**
 * How many CONVERSATIONAL rows before the seed are examined for ambiguity.
 *
 * Conversational is the load-bearing word: `tool_step` rows are ordinary
 * message rows (role='assistant', sender_kind='agent') and a thread-level load
 * returns every one of them, so one agent turn with six Bash calls would
 * otherwise fill this entire window with chips from a single turn — hiding a
 * second agent and silently defeating the ambiguity check that is the only
 * reason this window exists.
 */
const CONTINUITY_LOOKBACK = 6;

/**
 * Cost damper on the PAID tier: at most this many elections per session per
 * window. In-process, so the effective cap is machines x this number.
 *
 * That imprecision is acceptable HERE and nowhere else: overshooting a cost
 * damper costs cents, whereas overshooting a correctness guard runs a turn
 * twice. Correctness is held by the one-active-job-per-(session, agent) unique
 * index, never by this.
 */
const AMBIENT_ELECTION_MAX_PER_WINDOW = 12;
const AMBIENT_ELECTION_WINDOW_MS = 5 * 60 * 1000;

/** Sessions tracked by one budget before expired entries are swept. */
const AMBIENT_BUDGET_SWEEP_AT = 500;

/**
 * True when a row was written by a PERSON.
 *
 * Deliberately narrower than "not agent-authored", which is what the ambient
 * gate used to test. A schedule seed is sender_kind='system' and an automation
 * post is sender_kind='automation'; both satisfy "not an agent". Automations
 * cannot reach the dispatcher today, but AGENTS.md anticipates a dispatch_agent
 * action landing, and the day it does, "not an agent" would let a machine open
 * a paid turn budget that only a human is supposed to open.
 */
function isHumanAuthored(row) {
 return row != null && row.sender_kind === 'user';
}

/**
 * The per-agent off switch. An absent or null column reads as ON.
 *
 * Fail-open on purpose, matching normalizeConversationMode: a row written
 * before the migration, or by an older client, must not go silent. The failure
 * a strict Boolean() would cause is the one this repo has already shipped and
 * cannot see — nothing errors, an agent simply never speaks again.
 */
function ambientRepliesEnabled(agent) {
 return agent != null && agent.ambient_replies !== false;
}

/** Rows that are part of the conversation, as opposed to a turn's tool chips. */
function isConversationalRow(row) {
 return row != null && row.message_kind !== 'tool_step';
}

/**
 * A post not worth a paid relevance call: no letters and no digits at all.
 *
 * STRUCTURAL, never semantic. A keyword list ("ok", "thanks", "lol") would
 * silently swallow "ship it" and "deploy?", and a wrong verdict here is
 * invisible — the agent just doesn't answer and nobody knows why.
 * shared/replyCadence.cjs already argues this case and lands the same way.
 *
 * Unicode-aware, so a message in Greek, Cyrillic or Japanese is substantive
 * while an emoji-only reaction is not.
 */
function isStructurallyTrivial(text) {
 return !/[\p{L}\p{N}]/u.test(String(text == null ? '' : text));
}

const defaultTextOf = (value) => (typeof value === 'string' ? value : String(value == null ? '' : value));

/**
 * The agent this human is demonstrably mid-conversation with, or null.
 *
 * Derived from the transcript rather than stored. A stored "Jason is talking to
 * Scout" pointer can lie — it survives the agent being deleted, the thread
 * being soft-deleted, the channel being split — and each of those lies spends a
 * paid turn on the wrong agent. A value recomputed from the rows already loaded
 * has no such failure mode, needs no TTL sweeper, no invalidation, and no
 * coordination between Fly machines. It is the same call this repo already made
 * and wrote down for the cycle brake: "the cycle brake is carried by the data
 * ... this is why there is no `depth` column on `messages`".
 *
 * SEVEN CONJUNCTIVE CONDITIONS. Every one of them can only refuse:
 *
 *   C1  the seed was written by a person (not a schedule, task or automation)
 *   C2  the seed names nobody — belt; an @handle already routed upstream
 *   C0  tool_step chips are dropped BEFORE C3/C4 are evaluated
 *   C3  exactly ONE distinct agent in the conversational lookback window
 *   C4  that agent authored the immediately preceding conversational row
 *   C5  it spoke within ttlMs
 *   C6  the human before it is the SAME person as the seed's author
 *   C7  that agent is eligible (enabled, ambient replies on, in the pool)
 *
 * @param {object}   args
 * @param {object[]} args.rows        loadChannelMessages output, oldest-first
 * @param {number}   args.startIdx    index of the human seed (last role='user')
 * @param {number}   args.nowMs       injected clock
 * @param {number}   [args.ttlMs]
 * @param {number}   [args.lookback]
 * @param {Function} [args.isEligible]  (agentId) => boolean
 * @param {Function} [args.textOf]      row content -> string
 * @returns {{ agentId: string, reason: string } | null}
 */
function openInterlocutor({
 rows,
 startIdx,
 nowMs,
 ttlMs = CONTINUITY_TTL_MS,
 lookback = CONTINUITY_LOOKBACK,
 isEligible,
 textOf = defaultTextOf,
} = {}) {
 if (!Array.isArray(rows)) return null;
 const seed = rows[startIdx];
 if (!seed) return null;

 // C1 — only a person continues a conversation. A schedule seed reads as a
 // human row (role='user') but is machine-written, and it always names its
 // agent anyway, so it routes through mentions long before here.
 if (!isHumanAuthored(seed)) return null;

 // C2 — belt. The mention path runs first and would already have elected, but
 // that ordering is not something this function should have to assume.
 if (parseMentionHandles(textOf(seed.content)).length > 0) return null;

 // C0 — chips out FIRST. Without this, C4 matches a tool chip rather than an
 // answer, and C3 counts one agent because the window never reaches back far
 // enough to see the second. message_kind is already in the projection, so
 // this costs nothing.
 const prior = rows.slice(0, startIdx).filter(isConversationalRow);
 if (prior.length === 0) return null;

 // C4 — "I replied to what X just said". Anything else (another human's post,
 // a system marker) between X and the seed means this is not a continuation.
 const lastIdx = prior.length - 1;
 const last = prior[lastIdx];
 if (!last || last.sender_kind !== 'agent') return null;
 const agentId = String(last.sender_id || '');
 if (!agentId) return null;

 // C3 — two agents in play is genuinely ambiguous. Fall through to the paid
 // router, which reads the actual text, rather than guessing confidently.
 const window = prior.slice(Math.max(0, prior.length - Math.max(1, lookback)));
 const distinct = new Set();
 for (const row of window) {
  if (row.sender_kind === 'agent' && row.sender_id) distinct.add(String(row.sender_id));
 }
 if (distinct.size !== 1) return null;

 // C5 — still the same sitting.
 const spokeAt = Date.parse(String(last.created_at || ''));
 if (!Number.isFinite(spokeAt)) return null;
 const age = Number(nowMs) - spokeAt;
 if (!Number.isFinite(age) || age < 0 || age > Number(ttlMs)) return null;

 // C6 — it is YOUR conversation, not one you walked into. The human who
 // prompted X must be the human posting now.
 let priorHuman = null;
 for (let i = lastIdx - 1; i >= 0; i--) {
  if (prior[i].role === 'user') { priorHuman = prior[i]; break; }
 }
 if (!priorHuman) return null;
 if (!isHumanAuthored(priorHuman)) return null;
 if (String(priorHuman.sender_id || '') !== String(seed.sender_id || '')) return null;

 // C7 — the off switches, and pool membership. Passed in as a predicate so
 // this module never touches the database or an agent row's schema.
 if (typeof isEligible === 'function' && !isEligible(agentId)) return null;

 return { agentId, reason: 'continuity' };
}

/**
 * A per-session sliding budget for the PAID tier.
 *
 * Same shape as conversationLocks and cadenceWakes: an in-process Map, reset
 * between tests. Created by a factory rather than exported as a singleton so a
 * test can hold its own instance and so the module stays free of module-level
 * mutable state.
 */
function createAmbientElectionBudget({
 max = AMBIENT_ELECTION_MAX_PER_WINDOW,
 windowMs = AMBIENT_ELECTION_WINDOW_MS,
} = {}) {
 const windows = new Map();

 /** Drop windows that have rolled over, so a long-lived process does not grow a
  *  row per session it has ever seen. */
 function sweep(nowMs) {
  for (const [key, entry] of windows) {
   if (nowMs - entry.startedAt >= windowMs) windows.delete(key);
  }
 }

 return {
  /** Consume one election. False = over budget, make no model call. */
  take(sessionId, nowMs = Date.now()) {
   const key = String(sessionId || '');
   if (!key) return false;
   if (windows.size >= AMBIENT_BUDGET_SWEEP_AT) sweep(nowMs);
   const entry = windows.get(key);
   if (!entry || nowMs - entry.startedAt >= windowMs) {
    windows.set(key, { startedAt: nowMs, count: 1 });
    return true;
   }
   if (entry.count >= max) return false;
   entry.count += 1;
   return true;
  },
  reset() { windows.clear(); },
  get size() { return windows.size; },
 };
}

module.exports = {
 AMBIENT_ELECTION_MAX_PER_WINDOW,
 AMBIENT_ELECTION_WINDOW_MS,
 CONTINUITY_LOOKBACK,
 CONTINUITY_TTL_MS,
 ambientRepliesEnabled,
 createAmbientElectionBudget,
 isConversationalRow,
 isHumanAuthored,
 isStructurallyTrivial,
 openInterlocutor,
};
