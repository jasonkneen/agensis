'use strict';

// Thread harvest: mine a discarded conversation for what was worth keeping.
//
// A thread that gets cleared or soft-deleted is usually the END of some piece of
// work, which makes it the moment the workspace is most likely to LOSE what the
// work taught it. The transcript still holds a repeatable procedure, a durable
// fact about how this project behaves, or a decision worth writing down — and
// then the row is hidden and nobody reads it again.
//
// So a soft-delete queues a background analysis. A worker loads the transcript,
// asks a model what skills / memories / documents could be gleaned from it, and
// stores the answer as PROPOSALS on `thread_harvests`.
//
// Deliberately proposals, never direct writes. Auto-inserting memory_facts and
// documents from every discarded thread would poison the two stores a human
// trusts most, and it would do so invisibly — the thread is already hidden, so
// nobody would be reviewing the source. A proposal is reviewable; a silent write
// is not.
//
// The soft-deleted row is NEVER resurrected or un-deleted by any of this. The
// harvest reads it and writes elsewhere.

// A transcript is prompt input, so it is bounded twice: per message (one long
// paste cannot crowd out fifty short exchanges) and in total.
const HARVEST_MAX_MESSAGES = 120;
const HARVEST_MAX_MESSAGE_CHARS = 1500;
const HARVEST_MAX_TRANSCRIPT_CHARS = 60_000;

// Below this there is nothing to learn — an empty thread, or one message and a
// misclick. Harvesting them would spend a model call per discarded draft.
const HARVEST_MIN_MESSAGES = 4;

const HARVEST_KINDS = ['skill', 'memory', 'doc'];

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

function harvestPrompt({ title, transcript }) {
  return [
    'A conversation in this workspace was just discarded (cleared or deleted).',
    'Before it is forgotten, identify what the workspace should KEEP from it.',
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
 } = deps;

 /**
  * Queue an analysis for a thread that was just discarded.
  *
  * Idempotent per session: the partial unique index below means a second delete
  * of the same thread cannot stack a second pending row. Fails OPEN — a harvest
  * that cannot be queued must never cost somebody their delete.
  */
 async function queueThreadHarvest({ workspaceId, sessionId, reason = 'deleted', requestedBy = null } = {}) {
  if (!workspaceId || !sessionId) return null;
  try {
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
 async function loadHarvestSource(sessionId) {
  const sessions = await getDb().unsafe(
   'select id, title, workspace_id from chat_sessions where id = $1 limit 1',
   [String(sessionId)],
  );
  if (!sessions[0]) return null;
  const messages = await getDb().unsafe(
   `select role, content, sender_name, message_kind
      from messages
      where session_id = $1 and deleted_at is null
      order by created_at asc
      limit 500`,
   [String(sessionId)],
  );
  return { session: sessions[0], messages };
 }

 async function finishHarvest(id, patch) {
  const rows = await getDb().unsafe(
   `update thread_harvests
       set status = $2, findings = $3::jsonb, error = $4, updated_at = now()
       where id = $1
       returning *`,
   [id, patch.status, patch.findings ?? [], patch.error ?? null],
  );
  if (rows.length) notifyDbSubscribers('thread_harvests', 'UPDATE', rows);
  return rows[0] || null;
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
   const source = await loadHarvestSource(harvest.session_id);
   if (!source) return finishHarvest(harvest.id, { status: 'error', error: 'thread not found' });

   // Cheap threads never reach the model. Recorded as 'skipped', not 'error':
   // nothing went wrong, there was simply nothing to learn.
   if (!isWorthHarvesting(source.messages)) {
    return finishHarvest(harvest.id, { status: 'skipped', findings: [] });
   }

   const { transcript } = buildHarvestTranscript(source.messages);
   const text = await runAnthropicCompletion({
    messages: [{ role: 'user', content: harvestPrompt({ title: source.session.title, transcript }) }],
    memory: [],
    documents: [],
    workspaceContext: '',
    agentContext: '',
    workspaceId: harvest.workspace_id,
    usageKind: 'thread_harvest',
   });

   return finishHarvest(harvest.id, { status: 'done', findings: parseHarvestFindings(text) });
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

 return { queueThreadHarvest, loadHarvestSource, runOneThreadHarvest, runDueThreadHarvests };
}

module.exports = {
  createThreadHarvest,
  buildHarvestTranscript,
  harvestMessageLine,
  harvestPrompt,
  isDiscardTransition,
  isWorthHarvesting,
  parseHarvestFindings,
  HARVEST_KINDS,
  HARVEST_MAX_MESSAGES,
  HARVEST_MAX_MESSAGE_CHARS,
  HARVEST_MAX_TRANSCRIPT_CHARS,
  HARVEST_MIN_MESSAGES,
};
