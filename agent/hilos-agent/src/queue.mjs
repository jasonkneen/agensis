// Per-agent work queue + cancel/dedupe intent helpers. Pure + dependency-free
// so it stands alone and is unit-testable. (Mirror of scripts/lib/queue.mjs —
// keep the two equivalent.)
//
// Why: the poll loop used to `await` each multi-minute run inline, so the daemon
// stopped fetching while it worked — rapid mentions from several people queued up
// invisibly (or were dropped), and there was no way to interrupt. This queue lets
// the loop keep polling: it enqueues work, the queue runs it one at a time, and a
// plain-text "stop" picked up on the same poll can cancel the active run.

/** Normalize task text for dedupe: lowercase, strip @mentions, collapse space. */
export function normalizeTask(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/@[a-z0-9-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Burst-dedupe key: same requester + same thread (or channel) + same normalized
 *  ask. A burst of identical pings from ONE person collapses to one job (one ask
 *  never spawns N branches), but two different people asking the same thing stay
 *  distinct. `author` is a display name (not a stable id), so same-named users can
 *  still collide — acceptable until the mention payload carries a user id. */
export function dedupeKey(message, channelId) {
  const scope = (message && message.parentId) || channelId || "";
  const who = (message && message.author) || "";
  return `${scope}::${who}::${normalizeTask(message && message.body)}`;
}

const CANCEL_LEADING =
  /^(stop|cancel|abort|halt|nvm|never ?mind|hold on|forget (it|that)|scrap (it|that)|stop (it|that|working))\b/;
const CANCEL_WHOLE = /^(stop|cancel|abort|halt|nvm|never ?mind|forget it)[.!]?$/;

/**
 * Is this message a "stop what you're doing" intent — not a task that merely
 * contains the word "stop" (e.g. "stop the navbar from overflowing")? Tight by
 * design: a whole-message stop/cancel, or a short message led by a cancel verb.
 * Callers MUST also gate on "is something actually running" so a stray "stop"
 * with nothing active stays ordinary chat.
 */
export function looksLikeCancel(text) {
  const t = normalizeTask(text);
  if (!t) return false;
  if (CANCEL_WHOLE.test(t)) return true;
  if (t.split(" ").length <= 4 && CANCEL_LEADING.test(t)) return true;
  return false;
}

/**
 * In-process FIFO worker. `runJob(job, { signal })` is awaited one at a time
 * (concurrency 1 — parallel CLI runs on one checkout would collide on git state).
 *
 * - enqueue(job) → { accepted, deduped, position, startedImmediately }. `job.key`
 *   (optional) dedupes against the active + queued jobs.
 * - cancelActive(reason) aborts ONLY the in-flight job's AbortSignal; queued jobs
 *   are untouched.
 * - idle() resolves when nothing is active or queued (used to drain on --once).
 */
/**
 * @param {{
 *   runJob: (job: any, ctx: { signal: AbortSignal }) => Promise<void> | void,
 *   concurrency?: number,
 * }} [opts]
 */
export function createQueue(opts = {}) {
  const { runJob, concurrency = 1 } = opts;
  void concurrency; // single-slot in v1; documented in the ticket.
  const queued = [];
  let active = null; // { job, controller }
  let draining = false;
  let idleResolvers = [];

  function has(key) {
    if (key == null) return false;
    // A cancelled job is on its way out (it stays in `active` until its abort
    // tears the run down), so it must NOT dedupe-block a re-ask of the same thing
    // — otherwise "stop" + re-issue the same task gets silently swallowed.
    if (active && !active.cancelled && active.job.key === key) return true;
    return queued.some((j) => j.key === key);
  }

  async function drain() {
    if (draining) return;
    draining = true;
    while (queued.length) {
      const job = queued.shift();
      const controller = new AbortController();
      active = { job, controller };
      try {
        await runJob(job, { signal: controller.signal });
      } catch {
        // runJob is expected to handle its own errors; never break the loop.
      }
      active = null;
    }
    draining = false;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const r of resolvers) r();
  }

  function enqueue(job) {
    if (job && job.key != null && has(job.key)) {
      return { accepted: false, deduped: true, position: 0, startedImmediately: false };
    }
    const startedImmediately = !active && queued.length === 0;
    queued.push(job);
    const position = queued.length + (active ? 1 : 0); // 1-based, including active
    void drain();
    return { accepted: true, deduped: false, position, startedImmediately };
  }

  function cancelActive(reason) {
    if (!active) return false;
    active.cancelled = true; // stop it from dedupe-blocking a same-key re-ask
    active.controller.abort(reason || "cancelled");
    return true;
  }

  function size() {
    return queued.length;
  }
  function activeCount() {
    return active ? 1 : 0;
  }
  function idle() {
    if (!active && queued.length === 0) return Promise.resolve();
    return new Promise((r) => idleResolvers.push(r));
  }

  return { enqueue, cancelActive, has, size, active: activeCount, idle };
}
