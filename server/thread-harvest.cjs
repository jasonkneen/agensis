'use strict';

// Suggestions: mine this workspace's conversations for what was worth keeping.
//
// Called "Suggestions" everywhere a person sees it. The table, the routes and
// this module keep the older `thread_harvest` name: renaming a live table that
// two backends read buys nothing a human can see, and a rename landing on one
// deploy target before the other is an outage. The vocabulary boundary is the
// frontend (src/lib/suggestions.ts), which is where the words are read.
//
// A conversation holds a repeatable procedure, a durable fact about how this
// project behaves, or a decision worth writing down. Left alone it stays buried
// in a transcript nobody scrolls back through. So a worker reads one, asks a
// model what skills / memories / documents could be gleaned from it, and stores
// the answer as PROPOSALS on `thread_harvests`.
//
// TWO TRIGGERS, both of which mean "this piece of work is finished":
//
//  - 'deleted' — a soft-delete. The original trigger, and the sharpest signal
//    there is: the thread is about to stop being read at all.
//  - 'idle'    — a live conversation with nothing new for SUGGEST_IDLE_MINUTES.
//    A live chat has no delete edge to hang off, and going quiet is the closest
//    thing it has to a conclusion. Mid-conversation triggers (a message count,
//    a periodic sweep) were rejected: they fire while the work is still being
//    figured out, so they capture the guesses rather than the answer, and they
//    re-fire for as long as the chat stays busy.
//
// Cost is the governing constraint, and it is bounded in FOUR independent
// places rather than one: a per-session cooldown, a watermark so a long channel
// is never re-read from message 1, a cap on how many sessions one sweep may
// enqueue, and the pre-existing cap on how many the worker drains per tick. Any
// one of them failing open still leaves the other three.
//
// Deliberately proposals, never direct writes. Auto-inserting memory_facts and
// documents from every conversation would poison the two stores a human trusts
// most, and it would do so invisibly. A proposal is reviewable; a silent write
// is not.
//
// PRIVATE SESSIONS ARE NOT MINED AT ALL — not on the idle sweep, and not on
// delete either. A suggestion is listed to the whole workspace and rides the
// realtime fanout's open lane (server/realtime.cjs only routes `chat_sessions`
// down the members-only lane), so a proposal drawn out of somebody's DM would
// reach every socket in the workspace with the DM's content inside it. The
// check lives in queueThreadHarvest, so BOTH triggers inherit it, and the list
// query repeats it so rows queued before this rule existed stay hidden too.
//
// The soft-deleted row is NEVER resurrected or un-deleted by any of this. The
// worker reads it and writes elsewhere.

// A transcript is prompt input, so it is bounded twice: per message (one long
// paste cannot crowd out fifty short exchanges) and in total.
const { normalizeWorkspaceSkill } = require('../shared/workspaceSkills.cjs');

const HARVEST_MAX_MESSAGES = 120;
const HARVEST_MAX_MESSAGE_CHARS = 1500;
const HARVEST_MAX_TRANSCRIPT_CHARS = 60_000;

// Below this there is nothing to learn — an empty thread, or one message and a
// misclick. Harvesting them would spend a model call per discarded draft.
const HARVEST_MIN_MESSAGES = 4;

const HARVEST_KINDS = ['skill', 'memory', 'doc'];

// --- what makes a live conversation due -------------------------------------
//
// These four numbers ARE the cost control, so each one is here with the reason
// it has the value it has rather than in a config nobody reads.

// Quiet for this long and the piece of work is over. Short enough that a chat
// finished after lunch has its suggestions the same evening; long enough that a
// conversation pausing while somebody makes tea is not "finished".
const SUGGEST_IDLE_MINUTES = 180;

// The floor between two analyses of the SAME conversation, whatever it does in
// between. This is the number that stops a busy channel from being the whole
// bill: however much it is used, it can cost at most two model calls a day.
const SUGGEST_COOLDOWN_HOURS = 12;

// Older than this and a conversation is history, not recently-finished work.
// Its real job is the FIRST run after deploy: without it, every session the
// workspace has ever had becomes due in the same tick, and the backlog is the
// whole archive instead of the last fortnight.
const SUGGEST_MAX_AGE_DAYS = 14;

// How many conversations one sweep may enqueue. The worker's own per-tick cap
// bounds spend on its own; this bounds the QUEUE, so a backlog is visibly short
// rather than a thousand rows deep pretending it will get to them.
const SUGGEST_SWEEP_LIMIT = 5;

// How often the sweep looks. Not on the shared 30s tick: the selector is a
// join over messages, the cooldown means it has nothing to do 99% of the time,
// and five minutes of latency on a three-hour idle threshold is not latency.
const SUGGEST_SWEEP_INTERVAL_MS = 5 * 60_000;

/**
 * Did this write just discard a thread?
 *
 * TRUE only on the null -> timestamp EDGE. A repeated delete (two clients, a
 * retry, an idempotent client that re-sends the same patch) must not queue a
 * second harvest, and an UNDELETE must not queue one at all.
 */
function isDiscardTransition(before, after) {
  const had = before && before.deleted_at ? String(before.deleted_at) : '';
  const has = after && after.deleted_at ? String(after.deleted_at) : '';
  return !had && !!has;
}

/** Strip a message down to what a model can learn from, with hard caps. */
function harvestMessageLine(message) {
  if (!message || typeof message !== 'object') return '';
  // Tool chips are machinery, not content. They say a grep ran, never what it
  // meant, and on a long agent turn they outnumber real messages ten to one —
  // so including them spends the transcript budget on noise.
  if (String(message.message_kind || '')) return '';
  const raw = typeof message.content === 'string' ? message.content : '';
  const body = raw.replace(/\s+/g, ' ').trim();
  if (!body) return '';
  const who = String(message.sender_name || message.role || 'unknown').trim() || 'unknown';
  const clipped = body.length > HARVEST_MAX_MESSAGE_CHARS
    ? `${body.slice(0, HARVEST_MAX_MESSAGE_CHARS)}…`
    : body;
  return `${who}: ${clipped}`;
}

/**
 * Oldest-first transcript, capped.
 *
 * When the cap bites we keep the NEWEST messages: a thread's conclusion — what
 * was decided, what finally worked — is what a harvest is after. The opening is
 * usually someone finding their footing.
 */
function buildHarvestTranscript(messages) {
  const lines = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    const line = harvestMessageLine(message);
    if (line) lines.push(line);
  }
  const kept = lines.slice(-HARVEST_MAX_MESSAGES);
  let transcript = kept.join('\n');
  if (transcript.length > HARVEST_MAX_TRANSCRIPT_CHARS) {
    transcript = transcript.slice(-HARVEST_MAX_TRANSCRIPT_CHARS);
    // Never begin mid-line: a half sentence with no speaker reads as corruption.
    const firstBreak = transcript.indexOf('\n');
    if (firstBreak > -1) transcript = transcript.slice(firstBreak + 1);
  }
  return { transcript, messageCount: kept.length };
}

/** Enough here to be worth a model call? */
function isWorthHarvesting(messages) {
  const { messageCount } = buildHarvestTranscript(messages);
  return messageCount >= HARVEST_MIN_MESSAGES;
}

/**
 * The opening line, which differs by trigger because the two are not the same
 * situation and a model told the wrong one writes for the wrong one. A deleted
 * thread is a last chance; a quiet one is a checkpoint on work that may well
 * carry on tomorrow, and saying so is what stops the answer being written as an
 * obituary.
 */
function harvestPromptOpening(reason) {
  if (String(reason || '') === 'idle') {
    return [
      'A conversation in this workspace has gone quiet, so the piece of work in it',
      'has probably finished. Identify what the workspace should KEEP from it.',
    ];
  }
  return [
    'A conversation in this workspace was just discarded (cleared or deleted).',
    'Before it is forgotten, identify what the workspace should KEEP from it.',
  ];
}

function harvestPrompt({ title, transcript, reason = 'deleted', incremental = false }) {
  return [
    ...harvestPromptOpening(reason),
    // Said plainly, because otherwise the model opens with "the conversation
    // begins mid-discussion" and treats the missing context as the finding.
    ...(incremental
      ? [
        '',
        'Earlier parts of this conversation have ALREADY been reviewed, and what they',
        'taught is already recorded. Below is only the part since then. Judge it on its',
        'own and propose nothing you would have to have read the earlier part to write.',
      ]
      : []),
    '',
    `Conversation title: ${title || '(untitled)'}`,
    '',
    '--- transcript ---',
    transcript,
    '--- end transcript ---',
    '',
    'Return ONLY a JSON object, no prose and no code fence, shaped:',
    '{"findings":[{"kind":"skill|memory|doc","title":"...","body":"...","why":"..."}]}',
    '',
    'kind meanings:',
    '- "skill": a repeatable procedure someone could follow again. Write the body as steps.',
    '- "memory": a short durable FACT about this project, team or system that will still',
    '  be true next month. One fact per finding.',
    '- "doc": an explanation or decision record worth a written page.',
    '',
    'Rules:',
    '- Only include something a person would genuinely want again later.',
    '- Return {"findings":[]} if the conversation taught nothing durable. That is a',
    '  perfectly good answer and is much better than padding.',
    '- Do not restate what happened. Capture what was LEARNED.',
    '- No secrets, tokens, credentials or personal data in any field.',
    '- "why" is one sentence saying why it is worth keeping.',
  ].join('\n');
}

/**
 * Parse the model's answer into validated findings.
 *
 * Tolerant of a code fence and of surrounding prose, because a model that is
 * told "JSON only" still occasionally wraps it. Anything malformed is DROPPED
 * rather than stored: a half-parsed proposal shown to a human as a suggestion is
 * worse than one fewer suggestion.
 */
function parseHarvestFindings(text) {
  const raw = typeof text === 'string' ? text : '';
  if (!raw.trim()) return [];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return [];
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return [];
  }
  const findings = Array.isArray(parsed?.findings) ? parsed.findings : [];
  const clean = [];
  for (const finding of findings) {
    if (!finding || typeof finding !== 'object') continue;
    const kind = String(finding.kind || '').trim().toLowerCase();
    if (!HARVEST_KINDS.includes(kind)) continue;
    const title = String(finding.title || '').replace(/\s+/g, ' ').trim();
    const body = String(finding.body || '').trim();
    if (!title || !body) continue;
    clean.push({
      kind,
      title: title.slice(0, 200),
      body: body.slice(0, 4000),
      why: String(finding.why || '').replace(/\s+/g, ' ').trim().slice(0, 400),
    });
  }
  return clean;
}

// ---------------------------------------------------------------------------
// Deduplication.
//
// The same fact surfaces again and again — it is the nature of the thing being
// mined. One workspace convention gets explained in four different chats, and
// without this every one of them proposes it. Worse, a proposal a human has
// already ANSWERED coming back is the single behaviour most likely to get the
// feature switched off: dismissing something twice reads as not being listened
// to, and accepting it twice puts two copies of one fact into memory.
//
// So the check is at STORE time, not at read time. A filtered list still leaves
// the duplicate in the row, where the next change to the list query can leak it
// back out; dropping it before the insert means it does not exist.
//
// Scope is the workspace and it ignores the verdict — accepted, dismissed and
// still-waiting all count as "already proposed". A pending duplicate is exactly
// as annoying as a decided one, and it is the same fix.
// ---------------------------------------------------------------------------

function normalizeForFingerprint(value) {
  return String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The identity of a proposal, for "have we said this already".
 *
 * Keyed on the BODY for a memory and the TITLE for anything else, matching what
 * duplicateOf() compares on the review screen — a memory is its fact, so two
 * headings over one fact are one proposal, whereas a doc is its subject and two
 * pages about different things may open with the same sentence.
 *
 * Normalised because a model rewrites punctuation and casing freely while
 * saying exactly the same thing, and an exact-string check would therefore
 * catch almost nothing.
 */
function suggestionFingerprint(finding) {
  const kind = String(finding?.kind || '').trim().toLowerCase();
  const key = normalizeForFingerprint(kind === 'memory' ? finding?.body : finding?.title);
  return key ? `${kind}:${key}` : '';
}

/**
 * Drop the proposals this workspace has already been shown.
 *
 * Also dedupes WITHIN the batch: one analysis can return the same fact twice
 * under two headings, and there is no reason to make a person answer it twice.
 */
function dedupeFindings(findings, seenFingerprints) {
  const seen = seenFingerprints instanceof Set ? new Set(seenFingerprints) : new Set(seenFingerprints || []);
  const kept = [];
  for (const finding of Array.isArray(findings) ? findings : []) {
    const fingerprint = suggestionFingerprint(finding);
    // A finding with no usable fingerprint is kept rather than dropped: it is
    // the model's answer, and silently discarding it because our key came out
    // empty would lose a real proposal to a normalisation quirk.
    if (fingerprint && seen.has(fingerprint)) continue;
    if (fingerprint) seen.add(fingerprint);
    kept.push(finding);
  }
  return kept;
}

// ---------------------------------------------------------------------------
// Review: what happens when a human answers a proposal.
//
// A finding carries its own verdict inside the jsonb array rather than in a
// second table. There is no id to key a side table on — the model returns an
// unordered list, and `findings` is only ever written whole by the worker — so
// the index IS the identity, and the verdict lives on the element it belongs to.
// ---------------------------------------------------------------------------

const HARVEST_DECISIONS = ['accepted', 'dismissed'];

/** The verdict already recorded on one finding, or '' if nobody has answered. */
function findingDecision(finding) {
  const decision = String(finding?.decision || '').trim().toLowerCase();
  return HARVEST_DECISIONS.includes(decision) ? decision : '';
}

/**
 * Where accepting a finding actually writes.
 *
 * Three kinds, three stores:
 *
 * - "memory" -> memory_facts, under its own category so a suggested fact is
 *   distinguishable from one a human typed.
 * - "doc"    -> documents.
 * - "skill"  -> documents too, in a Playbooks folder (was "Skills" — renamed
 *   because that name claimed to be the real thing). THIS IS DELIBERATE: a
 *   skill in this product is a SKILL.md a daemon owns on its own disk and
 *   mirrors up into `agent_skill_documents`, which is read-only in-app and
 *   keyed per agent. There is no app-side skill store to accept into, and
 *   attaching a bare name to `workspace_agents.skills` would record a claim
 *   without the procedure that makes it true. A written page is the honest
 *   landing place, and the UI says so before the click rather than after —
 *   but "Skills" as a folder name still implied it *was* the real registry,
 *   so it's named "Playbooks" instead. Promoting a Playbook into a real
 *   skill is a separate, human-triggered step once an app-side skill store
 *   exists (see feat/skill-store).
 */
function harvestAcceptTarget(finding) {
  const kind = String(finding?.kind || '').trim().toLowerCase();
  if (kind === 'memory') {
    return { table: 'memory_facts', label: 'Team memory', category: 'suggested', folder: '' };
  }
  if (kind === 'skill') {
    return { table: 'workspace_skills', label: 'Skills', category: '', folder: '' };
  }
  if (kind === 'doc') {
    return { table: 'documents', label: 'Documents · Suggestions', category: '', folder: 'Suggestions' };
  }
  return null;
}

/**
 * The body a "doc"/"skill" finding is written as.
 *
 * The provenance line is part of the DOCUMENT, not just the review screen: once
 * accepted, the page outlives the stored suggestion, and when the source was a
 * deleted thread it outlives that too, so a reader six months from now has no
 * other way to learn that a model proposed this and a human waved it through.
 */
function harvestDocumentContent(finding, source = {}) {
  const body = String(finding?.body || '').trim();
  const title = String(source.threadTitle || '').trim();
  const when = String(source.discardedAt || '').trim();
  const parts = [String(source.reason || '') === 'idle'
    ? 'Suggested from a conversation'
    : 'Suggested from a discarded conversation'];
  if (title) parts.push(`"${title}"`);
  if (when) parts.push(`(${when.slice(0, 10)})`);
  parts.push('— proposed by a model, accepted by a person.');
  return `${body}\n\n---\n\n_${parts.join(' ')}_`;
}

/**
 * One finding with a verdict written onto it. Returns a NEW object; the caller
 * writes exactly this element back, never the whole array (see decideHarvestFinding).
 */
function decidedFinding(finding, { decision, userId, userName, targetTable, targetId, now }) {
  const verdict = String(decision || '').trim().toLowerCase();
  return {
    ...finding,
    decision: HARVEST_DECISIONS.includes(verdict) ? verdict : '',
    decided_at: now || new Date().toISOString(),
    decided_by: userId ? String(userId) : null,
    decided_by_name: String(userName || '').slice(0, 200),
    ...(targetTable ? { target_table: targetTable } : {}),
    ...(targetId ? { target_id: String(targetId) } : {}),
  };
}

/** How much of a harvest is still waiting on somebody. */
function harvestReviewCounts(findings) {
  const list = Array.isArray(findings) ? findings : [];
  let accepted = 0;
  let dismissed = 0;
  for (const finding of list) {
    const decision = findingDecision(finding);
    if (decision === 'accepted') accepted += 1;
    else if (decision === 'dismissed') dismissed += 1;
  }
  return { total: list.length, pending: list.length - accepted - dismissed, accepted, dismissed };
}

/**
 * DB + worker half. A factory taking injected deps, matching every other module
 * here, so the queue/claim/analyse logic is testable against a fake db and a
 * fake model without standing up a server.
 */
function createThreadHarvest(deps = {}) {
 const {
  getDb,
  runAnthropicCompletion,
  notifyDbSubscribers = () => {},
  onWarn = () => {},
  // Only the review half needs these. Defaulted so the worker half still
  // constructs in tests that inject nothing but a fake db and a fake model.
  enforceWorkspaceRole = async () => {},
  badRequest = (message) => Object.assign(new Error(message), { status: 400 }),
  // The app-side skill store's writer (server/workspace-skills-routes.cjs).
  // Injected rather than imported so accepting a skill goes through the SAME
  // validator and the SAME insert as authoring one by hand — a second door with
  // different rules is how a store ends up with rows its own loader cannot read.
  // Undefined in tests that only exercise the worker half; the accept path says
  // so rather than writing a malformed row.
  writeWorkspaceSkill = null,
 } = deps;

 /**
  * Queue an analysis of one conversation. The single door both triggers use.
  *
  * Idempotent per session: the partial unique index below means a second delete
  * of the same thread cannot stack a second pending row. Fails OPEN — a harvest
  * that cannot be queued must never cost somebody their delete.
  *
  * Except on privacy, where the same catch fails CLOSED: if the DB will not say
  * whether the session is private, nothing is queued. A missing suggestion is
  * an absence; a suggestion mined from a DM is a disclosure.
  */
 async function queueThreadHarvest({ workspaceId, sessionId, reason = 'deleted', requestedBy = null } = {}) {
  if (!workspaceId || !sessionId) return null;
  try {
   // A private conversation is not mined, by either trigger. Suggestions are
   // listed to the whole workspace, so a proposal drawn out of a DM publishes
   // its contents to people who were never in it. Checked HERE rather than at
   // each call site so a future third trigger cannot forget.
   //
   // Same two-part test the read authorizer uses (shared/backend-core.cjs
   // isPrivateSessionRow): the column, and the folder for the older DMs that
   // predate it.
   const priv = await getDb().unsafe(
    `select 1 from chat_sessions
      where id = $1
        and (coalesce(visibility, 'workspace') = 'private' or coalesce(folder, '') = 'Direct messages')
      limit 1`,
    [String(sessionId)],
   );
   if (priv.length > 0) return null;

   const rows = await getDb().unsafe(
    `insert into thread_harvests (workspace_id, session_id, status, reason, requested_by)
       values ($1, $2, 'pending', $3, $4)
       on conflict do nothing
       returning *`,
    [String(workspaceId), String(sessionId), String(reason).slice(0, 40), requestedBy ? String(requestedBy) : null],
   );
   return rows[0] || null;
  } catch (error) {
   onWarn(`queue failed: ${error.message || error}`);
   return null;
  }
 }

 /**
  * Load the discarded thread's transcript.
  *
  * Reads the messages even though the SESSION is soft-deleted — that is the
  * whole point — but never un-deletes anything, and skips messages that were
  * themselves deleted, since a human removing a message is a signal not to keep
  * it.
  */
 async function loadHarvestSource(sessionId, excludeHarvestId = null) {
  const sessions = await getDb().unsafe(
   'select id, title, workspace_id from chat_sessions where id = $1 limit 1',
   [String(sessionId)],
  );
  if (!sessions[0]) return null;

  // The watermark: the newest message any COMPLETED analysis of this session
  // has already considered. Without it a channel that stays alive for months is
  // re-read from message 1 every time it goes quiet — the same tokens, the same
  // proposals, the same person dismissing them again.
  //
  // Only 'done' rows count. A 'skipped' or 'error' run considered nothing, and
  // letting it move the mark would silently drop those messages forever.
  const marks = await getDb().unsafe(
   `select max(cursor_at) as cursor_at
      from thread_harvests
     where session_id = $1 and status = 'done' and cursor_at is not null
       and ($2::uuid is null or id <> $2::uuid)`,
   [String(sessionId), excludeHarvestId ? String(excludeHarvestId) : null],
  );
  const cursorAt = marks[0]?.cursor_at || null;

  const messages = await getDb().unsafe(
   `select role, content, sender_name, message_kind, created_at
      from messages
      where session_id = $1 and deleted_at is null
        and ($2::timestamptz is null or created_at > $2::timestamptz)
      order by created_at asc
      limit 500`,
   [String(sessionId), cursorAt],
  );
  return { session: sessions[0], messages, cursorAt };
 }

 /**
  * How far this run may move the watermark: the newest message it READ.
  *
  * Read, not summarised. buildHarvestTranscript keeps only the newest
  * HARVEST_MAX_MESSAGES lines, so on a session that produced more than that in
  * one quiet-to-quiet window the middle is skipped rather than deferred. That
  * is the deliberate trade: marking only as far as the transcript reached would
  * make the next run start inside the same backlog and re-read it, every run,
  * for as long as the session stayed busier than the cap — which is precisely
  * the unbounded re-analysis the watermark exists to prevent.
  */
 function nextCursorAt(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
   const at = list[i] && list[i].created_at;
   if (at) return at;
  }
  return null;
 }

 /**
  * Settle a claimed harvest.
  *
  * Always returns a result, even when the UPDATE matched nothing (the thread and
  * its harvest were hard-deleted while the model was thinking). The claim already
  * happened, so this tick DID do work — reporting null here would abort the
  * drain loop below and leave the rest of a backlog sitting for another 30s.
  */
 async function finishHarvest(id, patch) {
  const rows = await getDb().unsafe(
   `update thread_harvests
       set status = $2, findings = $3::jsonb, error = $4,
           cursor_at = coalesce($5::timestamptz, cursor_at), updated_at = now()
       where id = $1
       returning *`,
   [id, patch.status, patch.findings ?? [], patch.error ?? null, patch.cursorAt ?? null],
  );
  if (rows.length) notifyDbSubscribers('thread_harvests', 'UPDATE', rows);
  return rows[0] || { id, status: patch.status, findings: patch.findings ?? [], error: patch.error ?? null };
 }

 /**
  * Everything this workspace has already proposed, as fingerprints.
  *
  * One query per analysis rather than a lookup per finding, and capped: a
  * workspace with a runaway number of stored proposals must not turn the dedup
  * check into the expensive half of the job. If the cap ever bit, the cost is
  * that an old duplicate slips through once — not that the analysis fails.
  */
 async function existingFingerprints(workspaceId) {
  try {
   const rows = await getDb().unsafe(
    `select f->>'kind' as kind, f->>'title' as title, f->>'body' as body
       from thread_harvests h
       cross join lateral jsonb_array_elements(h.findings) f
      where h.workspace_id = $1
      limit 2000`,
    [String(workspaceId)],
   );
   return new Set(rows.map(suggestionFingerprint).filter(Boolean));
  } catch (error) {
   // Fail OPEN. Dedup is a courtesy; losing it shows somebody a repeat, whereas
   // failing the run loses the analysis entirely.
   onWarn(`fingerprint lookup failed: ${error.message || error}`);
   return new Set();
  }
 }

 /**
  * Run ONE queued harvest.
  *
  * Claims with a compare-and-set on status so two server processes cannot both
  * analyse the same thread and bill two model calls for one answer.
  */
 async function runOneThreadHarvest() {
  const claimed = await getDb().unsafe(
   `update thread_harvests
       set status = 'running', updated_at = now()
       where id = (
         select id from thread_harvests
          where status = 'pending'
          order by created_at asc
          limit 1
       )
       and status = 'pending'
       returning *`,
  );
  const harvest = claimed[0];
  if (!harvest) return null;

  try {
   const source = await loadHarvestSource(harvest.session_id, harvest.id);
   if (!source) return finishHarvest(harvest.id, { status: 'error', error: 'thread not found' });

   // Cheap threads never reach the model. Recorded as 'skipped', not 'error':
   // nothing went wrong, there was simply nothing to learn. The watermark is
   // deliberately NOT moved — these messages have not been considered, and a
   // skip must not be the thing that makes them unreachable.
   if (!isWorthHarvesting(source.messages)) {
    return finishHarvest(harvest.id, { status: 'skipped', findings: [] });
   }

   const { transcript } = buildHarvestTranscript(source.messages);
   const text = await runAnthropicCompletion({
    messages: [{
     role: 'user',
     content: harvestPrompt({
      title: source.session.title,
      transcript,
      reason: harvest.reason,
      incremental: Boolean(source.cursorAt),
     }),
    }],
    memory: [],
    documents: [],
    workspaceContext: '',
    agentContext: '',
    workspaceId: harvest.workspace_id,
    usageKind: 'thread_harvest',
   });

   // Dedup AFTER the model call, not before: the model is what produces the
   // proposal, and there is nothing to compare until it has. The saving is the
   // person's attention, which is the scarcer of the two.
   const seen = await existingFingerprints(harvest.workspace_id);
   const findings = dedupeFindings(parseHarvestFindings(text), seen);

   return finishHarvest(harvest.id, {
    status: 'done',
    findings,
    cursorAt: nextCursorAt(source.messages),
   });
  } catch (error) {
   onWarn(`harvest ${harvest.id} failed: ${error.message || error}`);
   return finishHarvest(harvest.id, { status: 'error', error: String(error.message || error).slice(0, 500) });
  }
 }

 /**
  * Drain a bounded number per tick. Bounded because this runs on the shared 30s
  * interval alongside the job reapers: a backlog of fifty deleted threads must
  * not turn one tick into fifty serial model calls and stall everything behind
  * it. The backlog simply drains over the following ticks.
  */
 async function runDueThreadHarvests(limit = 3) {
  const done = [];
  for (let i = 0; i < limit; i += 1) {
   const result = await runOneThreadHarvest().catch((error) => {
    onWarn(`tick failed: ${error.message || error}`);
    return null;
   });
   if (!result) break;
   done.push(result);
  }
  return done;
 }

 /**
  * Enqueue the conversations that have gone quiet.
  *
  * ONE statement, insert-from-select, because the alternative — select the due
  * sessions, then insert them — has a window in which two server processes both
  * read the same session as due and both queue it. The partial unique index
  * catches that, but only after both have decided to spend.
  *
  * Every clause here is a spend limit, so none of them is optional:
  *
  *  - not deleted: a deleted thread comes through the delete edge instead, and
  *    queueing it here as well would analyse it twice.
  *  - not private: DMs are not mined at all. Repeated from queueThreadHarvest
  *    because this path does not go through it — the insert IS the queue.
  *  - quiet for SUGGEST_IDLE_MINUTES: the trigger itself.
  *  - active within SUGGEST_MAX_AGE_DAYS: bounds the first run after deploy to
  *    the recent past rather than the entire archive.
  *  - enough NEW messages since the watermark: a session that has said four
  *    things since its last analysis has something to add; one that has said
  *    nothing is not re-analysed at all, at any interval. This is the clause
  *    that makes "do not re-analyse the same conversation" true.
  *  - past the cooldown: the ceiling on one conversation's own cost.
  *  - nothing already open for it: no double-queue.
  *
  * The message count matches what buildHarvestTranscript will actually use —
  * tool chips and empty bodies excluded — so a session cannot be woken by
  * fifty tool steps and then skipped for having nothing in it.
  */
 async function sweepIdleSessionHarvests({
  idleMinutes = SUGGEST_IDLE_MINUTES,
  maxAgeDays = SUGGEST_MAX_AGE_DAYS,
  minNewMessages = HARVEST_MIN_MESSAGES,
  cooldownHours = SUGGEST_COOLDOWN_HOURS,
  limit = SUGGEST_SWEEP_LIMIT,
 } = {}) {
  try {
   const rows = await getDb().unsafe(
    `insert into thread_harvests (workspace_id, session_id, status, reason)
     select s.workspace_id, s.id, 'pending', 'idle'
       from chat_sessions s
       left join lateral (
         select max(h.cursor_at) as cursor_at, max(h.updated_at) as last_run_at
           from thread_harvests h
          where h.session_id = s.id
       ) prior on true
       left join lateral (
         select max(m.created_at) as last_at,
                count(*) filter (
                  where coalesce(m.message_kind, '') = ''
                    and coalesce(m.content, '') <> ''
                    and (prior.cursor_at is null or m.created_at > prior.cursor_at)
                ) as fresh
           from messages m
          where m.session_id = s.id and m.deleted_at is null
       ) recent on true
      where s.deleted_at is null
        and coalesce(s.visibility, 'workspace') <> 'private'
        and coalesce(s.folder, '') <> 'Direct messages'
        and recent.last_at is not null
        and recent.last_at < now() - make_interval(mins => $1::int)
        and recent.last_at > now() - make_interval(days => $2::int)
        and recent.fresh >= $3::int
        and (prior.last_run_at is null or prior.last_run_at < now() - make_interval(hours => $4::int))
        and not exists (
          select 1 from thread_harvests o
           where o.session_id = s.id and o.status in ('pending', 'running')
        )
      order by recent.last_at desc
      limit $5::int
     on conflict do nothing
     returning *`,
    [
     Math.max(1, Number(idleMinutes) || SUGGEST_IDLE_MINUTES),
     Math.max(1, Number(maxAgeDays) || SUGGEST_MAX_AGE_DAYS),
     Math.max(1, Number(minNewMessages) || HARVEST_MIN_MESSAGES),
     Math.max(0, Number(cooldownHours) || SUGGEST_COOLDOWN_HOURS),
     Math.min(Math.max(Number(limit) || SUGGEST_SWEEP_LIMIT, 1), 25),
    ],
   );
   return rows;
  } catch (error) {
   // Never throws. This runs on a timer with nobody watching, and a sweep that
   // cannot enqueue is a feature that goes quiet, not a server that falls over.
   onWarn(`idle sweep failed: ${error.message || error}`);
   return [];
  }
 }

 /**
  * The review queue for one workspace.
  *
  * Only harvests that ACTUALLY PROPOSED SOMETHING. A 'skipped' thread (too short
  * to learn from), an 'error' (the model call failed) and a 'done' harvest that
  * honestly found nothing are all correct outcomes with nothing to answer, and
  * listing them would bury the handful that need a person under a wall of rows
  * whose only content is "nothing here".
  *
  * Joins the thread back on so the card can say WHICH conversation this came
  * from and when it was discarded. LEFT join: the thread may since have been
  * hard-deleted, and losing the title must not lose the proposals.
  *
  * The privacy clause is the second of two — queueThreadHarvest already refuses
  * to mine a private session, so on a clean database this filters nothing. It
  * is here for the rows queued BEFORE that rule existed, which were mined from
  * DMs and are sitting in production right now.
  */
 async function listThreadHarvests({ workspaceId, limit = 50 } = {}) {
  const id = String(workspaceId || '').trim();
  if (!id) throw badRequest('workspace id is required');
  const capped = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return getDb().unsafe(
   `select h.id, h.workspace_id, h.session_id, h.status, h.reason, h.requested_by,
           h.findings, h.error, h.created_at, h.updated_at,
           s.title as session_title, s.deleted_at as session_deleted_at
      from thread_harvests h
      left join chat_sessions s on s.id = h.session_id
     where h.workspace_id = $1
       and h.status = 'done'
       and jsonb_array_length(h.findings) > 0
       and coalesce(s.visibility, 'workspace') <> 'private'
       and coalesce(s.folder, '') <> 'Direct messages'
     order by h.created_at desc
     limit $2`,
   [id, capped],
  );
 }

 /**
  * A human answers ONE proposal.
  *
  * This is the only path that turns a proposal into a real row, and it exists as
  * a route rather than a client write for the same reason the table is read-only
  * to clients: the client must not be able to name what gets written into
  * memory_facts / documents. The body it writes is the body the model produced,
  * read back out of the database here — the request says only WHICH finding and
  * accept-or-dismiss.
  *
  * Order is claim-then-write, the opposite of the permission-decision route.
  * There the risk was recording an approval that never reached the agent; here it
  * is writing the same fact into memory twice because two clicks raced. Claiming
  * the finding first makes accepting at-most-once, and a failed write rolls the
  * claim back so the proposal returns to the queue rather than reading "accepted"
  * with nothing behind it.
  */
 async function decideHarvestFinding({ userId, workspaceId, harvestId, index, decision } = {}) {
  const verdict = String(decision || '').trim().toLowerCase();
  if (!['accept', 'dismiss'].includes(verdict)) throw badRequest('decision must be accept or dismiss');
  const id = String(harvestId || '').trim();
  if (!id) throw badRequest('harvest id is required');
  const position = Number(index);
  if (!Number.isInteger(position) || position < 0) throw badRequest('index must be a whole number');

  // 'write' for both verdicts: accepting writes the same two stores that any
  // editor can already write directly, and dismissing is not the more dangerous
  // half of the pair — there is no escalation here to gate on 'manage'.
  await enforceWorkspaceRole(userId, String(workspaceId || ''), 'write');

  // The privacy clause is repeated here, and it is not redundant with the list
  // query. A suggestion is reached by ID on this path, so hiding it from the
  // list does not put it out of reach — and the boot-time purge only runs at
  // boot, which leaves a window for a conversation turned private WHILE a
  // suggestion mined from it is still sitting in somebody's open tab.
  // Accepting one of those would copy a private conversation's content into
  // memory_facts or documents, where the whole workspace reads it. Written as a
  // join condition rather than a check after the fetch so the row is never
  // loaded, and cannot be returned by the 404's error path either.
  const rows = await getDb().unsafe(
   `select h.*, s.title as session_title, s.deleted_at as session_deleted_at
      from thread_harvests h
      left join chat_sessions s on s.id = h.session_id
     where h.id = $1 and h.workspace_id = $2
       and coalesce(s.visibility, 'workspace') <> 'private'
       and coalesce(s.folder, '') <> 'Direct messages'
     limit 1`,
   [id, String(workspaceId || '')],
  );
  const harvest = rows[0];
  if (!harvest) throw Object.assign(new Error('That harvest was not found'), { status: 404 });
  if (harvest.status !== 'done') {
   throw Object.assign(new Error(`This harvest is ${harvest.status}, so it has nothing to review`), { status: 409 });
  }

  const findings = Array.isArray(harvest.findings) ? harvest.findings : [];
  const finding = findings[position];
  if (!finding) throw Object.assign(new Error('That proposal was not found'), { status: 404 });
  const already = findingDecision(finding);
  if (already) {
   throw Object.assign(new Error(`This proposal was already ${already}`), { status: 409, code: 'already_decided' });
  }
  const target = harvestAcceptTarget(finding);
  if (verdict === 'accept' && !target) throw badRequest('That proposal has no kind that can be accepted');

  const userRows = await getDb().unsafe('select display_name, email from app_users where id = $1 limit 1', [String(userId)]);
  const decidedByName = String(userRows[0]?.display_name || userRows[0]?.email || '').trim() || 'A workspace member';

  const claim = await writeFinding(id, position, decidedFinding(finding, {
   decision: verdict === 'accept' ? 'accepted' : 'dismissed',
   userId,
   userName: decidedByName,
   targetTable: verdict === 'accept' ? target.table : '',
  }), { requireUndecided: true });
  if (!claim) {
   throw Object.assign(new Error('This proposal was already decided'), { status: 409, code: 'already_decided' });
  }

  if (verdict === 'dismiss') {
   notifyDbSubscribers('thread_harvests', 'UPDATE', [claim]);
   return claim;
  }

  let written;
  try {
   written = await writeAcceptedFinding(harvest, finding, target);
  } catch (error) {
   // Put it back in the queue. A proposal reading "accepted" with nothing in
   // memory behind it is the one outcome this feature cannot produce.
   await writeFinding(id, position, finding, { requireUndecided: false }).catch(() => {});
   throw error;
  }

  const settled = await writeFinding(id, position, decidedFinding(finding, {
   decision: 'accepted',
   userId,
   userName: decidedByName,
   targetTable: target.table,
   targetId: written.id,
  }), { requireUndecided: false });
  const final = settled || claim;
  notifyDbSubscribers('thread_harvests', 'UPDATE', [final]);
  return final;
 }

 /**
  * Replace exactly ONE element of the findings array.
  *
  * jsonb_set rather than writing the whole array back: two people reviewing the
  * same harvest side by side are answering DIFFERENT proposals, and a read-patch-
  * write of the full array would silently discard whichever verdict landed first.
  * With `requireUndecided` the same statement is also the compare-and-set that
  * makes accepting at-most-once.
  */
 async function writeFinding(harvestId, position, finding, { requireUndecided }) {
  const guard = requireUndecided ? `and coalesce(findings->($2::int)->>'decision', '') = ''` : '';
  const rows = await getDb().unsafe(
   `update thread_harvests
       set findings = jsonb_set(findings, array[$2::text], $3::jsonb, false), updated_at = now()
     where id = $1 ${guard}
     returning *`,
   [harvestId, String(position), finding],
  );
  return rows[0] || null;
 }

 /** The actual write into the store a human trusts. Returns the created row. */
 async function writeAcceptedFinding(harvest, finding, target) {
  if (target.table === 'memory_facts') {
   const rows = await getDb().unsafe(
    'insert into memory_facts (workspace_id, fact, category) values ($1, $2, $3) returning *',
    [harvest.workspace_id, String(finding.body || '').slice(0, 4000), target.category],
   );
   notifyDbSubscribers('memory_facts', 'INSERT', rows);
   return rows[0];
  }
  if (target.table === 'workspace_skills') {
   if (typeof writeWorkspaceSkill !== 'function') {
    throw Object.assign(new Error('The skill store is not available on this backend'), { status: 501 });
   }
   // THROUGH THE SAME VALIDATOR AS AUTHORING ONE BY HAND. A model's proposal is
   // the least trusted input this store has — it is text mined out of a
   // conversation — so it must not get a shortcut past the name rule, the body
   // cap, or the never-carried-field refusal. `source: 'suggested'` and the
   // origin block are set HERE and cannot be influenced by the finding: a
   // procedure an agent will later follow must carry an honest record of the
   // fact that a model wrote it and a person waved it through.
   const result = normalizeWorkspaceSkill({
    title: String(finding.title || '').trim() || 'Untitled skill',
    summary: String(finding.summary || '').trim(),
    body: harvestDocumentContent(finding, {
     threadTitle: harvest.session_title,
     discardedAt: harvest.session_deleted_at ? String(harvest.session_deleted_at) : String(harvest.created_at || ''),
     reason: harvest.reason,
    }),
   });
   if (!result.ok) {
    throw Object.assign(new Error(`This proposal cannot be saved as a skill: ${result.errors.join('; ')}`), { status: 400 });
   }
   const row = await writeWorkspaceSkill({
    workspaceId: harvest.workspace_id,
    skill: result.skill,
    userId: null,
    source: 'suggested',
    origin: {
     harvestId: String(harvest.id || ''),
     sessionId: harvest.session_id ? String(harvest.session_id) : '',
     acceptedAt: new Date().toISOString(),
    },
   });
   if (!row) throw new Error('The skill could not be saved');
   notifyDbSubscribers('workspace_skills', 'INSERT', [row]);
   return row;
  }
  const content = harvestDocumentContent(finding, {
   threadTitle: harvest.session_title,
   discardedAt: harvest.session_deleted_at ? String(harvest.session_deleted_at) : String(harvest.created_at || ''),
   reason: harvest.reason,
  });
  const rows = await getDb().unsafe(
   'insert into documents (workspace_id, title, content, folder) values ($1, $2, $3, $4) returning *',
   [harvest.workspace_id, String(finding.title || 'Untitled').slice(0, 200), content, target.folder],
  );
  notifyDbSubscribers('documents', 'INSERT', rows);
  return rows[0];
 }

 return {
  queueThreadHarvest,
  loadHarvestSource,
  runOneThreadHarvest,
  runDueThreadHarvests,
  sweepIdleSessionHarvests,
  listThreadHarvests,
  decideHarvestFinding,
 };
}

/**
 * Routes. Both are workspace-scoped and go through enforceWorkspaceRole, so a
 * harvest can only ever be read or answered by a member of the workspace whose
 * thread produced it.
 */
function mountThreadHarvestRoutes(app, deps = {}) {
 const { requireAuth, jsonError, enforceWorkspaceRole, listThreadHarvests, decideHarvestFinding } = deps;

 app.get('/backend/workspaces/:workspaceId/thread-harvests', requireAuth, async (req, res) => {
  try {
   const workspaceId = String(req.params.workspaceId || '').trim();
   if (!workspaceId) return jsonError(res, 400, new Error('workspace id is required'));
   await enforceWorkspaceRole(req.userId, workspaceId, 'read');
   const rows = await listThreadHarvests({ workspaceId, limit: req.query?.limit });
   res.json({ data: rows, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });

 app.post('/backend/workspaces/:workspaceId/thread-harvests/:harvestId/findings/:index', requireAuth, async (req, res) => {
  try {
   const harvest = await decideHarvestFinding({
    userId: req.userId,
    workspaceId: String(req.params.workspaceId || '').trim(),
    harvestId: String(req.params.harvestId || '').trim(),
    index: Number(req.params.index),
    decision: req.body?.decision,
   });
   res.json({ data: harvest, error: null });
  } catch (error) {
   jsonError(res, error.status || 500, error);
  }
 });
}

module.exports = {
  createThreadHarvest,
  mountThreadHarvestRoutes,
  decidedFinding,
  findingDecision,
  harvestAcceptTarget,
  harvestDocumentContent,
  harvestReviewCounts,
  buildHarvestTranscript,
  dedupeFindings,
  harvestMessageLine,
  harvestPrompt,
  isDiscardTransition,
  isWorthHarvesting,
  parseHarvestFindings,
  suggestionFingerprint,
  HARVEST_DECISIONS,
  HARVEST_KINDS,
  HARVEST_MAX_MESSAGES,
  HARVEST_MAX_MESSAGE_CHARS,
  HARVEST_MAX_TRANSCRIPT_CHARS,
  HARVEST_MIN_MESSAGES,
  SUGGEST_COOLDOWN_HOURS,
  SUGGEST_IDLE_MINUTES,
  SUGGEST_MAX_AGE_DAYS,
  SUGGEST_SWEEP_INTERVAL_MS,
  SUGGEST_SWEEP_LIMIT,
};
