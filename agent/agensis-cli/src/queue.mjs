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
 * In-process lane-aware worker. `runJob(job, { signal })` runs jobs serially
 * WITHIN a lane and in parallel ACROSS lanes, up to `concurrency` jobs in flight.
 *
 * A "lane" is one conversation: pass `job.lane` (e.g. `sessionId::threadParentId`).
 * DMs, each channel, and each thread are distinct lanes, so a slow turn in one
 * never blocks another — while two messages in the SAME conversation still run in
 * order. Jobs with no `job.lane` share a single default lane ("") — the original
 * strictly-serial behaviour.
 *
 * - enqueue(job) → { accepted, deduped, position, startedImmediately }. `job.key`
 *   (optional) dedupes against every active + queued job in all lanes. `position`
 *   is 1-based within the job's own lane.
 * - cancelActive(reason, laneKey?) aborts in-flight jobs' AbortSignals; queued
 *   jobs are untouched. With no laneKey it cancels every lane's active job; with a
 *   laneKey it cancels only that conversation's active job.
 * - idle() resolves when nothing is active or queued anywhere (used to drain on
 *   --once). active() is the total in-flight count; size() the total queued.
 */
/**
 * @param {{
 *   runJob: (job: any, ctx: { signal: AbortSignal }) => Promise<void> | void,
 *   concurrency?: number,
 * }} [opts]
 */
export function createQueue(opts = {}) {
  const { runJob } = opts;
  const maxConcurrency = Math.max(1, Number(opts.concurrency) || 1);
  const lanes = new Map(); // laneKey -> { queued: [], active: { job, controller, cancelled } | null }
  let running = 0; // total in-flight across all lanes
  let idleResolvers = [];

  function laneOf(key) {
    let lane = lanes.get(key);
    if (!lane) {
      lane = { queued: [], active: null };
      lanes.set(key, lane);
    }
    return lane;
  }

  function has(key) {
    if (key == null) return false;
    // A cancelled job is on its way out (it stays in `active` until its abort
    // tears the run down), so it must NOT dedupe-block a re-ask of the same thing
    // — otherwise "stop" + re-issue the same task gets silently swallowed.
    for (const lane of lanes.values()) {
      if (lane.active && !lane.active.cancelled && lane.active.job.key === key) return true;
      if (lane.queued.some((j) => j.key === key)) return true;
    }
    return false;
  }

  // Start as many lane-head jobs as the global cap allows. Lanes are walked in
  // insertion order for rough fairness; only lanes with no active job are eligible.
  function pump() {
    for (const [laneKey, lane] of lanes) {
      if (running >= maxConcurrency) break;
      if (lane.active || lane.queued.length === 0) continue;
      const job = lane.queued.shift();
      const controller = new AbortController();
      lane.active = { job, controller, cancelled: false };
      running += 1;
      Promise.resolve()
        .then(() => runJob(job, { signal: controller.signal }))
        .catch(() => {
          // runJob is expected to handle its own errors; never break the pump.
        })
        .finally(() => {
          lane.active = null;
          running -= 1;
          if (lane.queued.length === 0 && !lane.active) lanes.delete(laneKey);
          pump();
          maybeResolveIdle();
        });
    }
  }

  function maybeResolveIdle() {
    if (running > 0) return;
    for (const lane of lanes.values()) if (lane.queued.length) return;
    const resolvers = idleResolvers;
    idleResolvers = [];
    for (const r of resolvers) r();
  }

  function enqueue(job) {
    if (job && job.key != null && has(job.key)) {
      return { accepted: false, deduped: true, position: 0, startedImmediately: false };
    }
    const laneKey = job && job.lane != null ? String(job.lane) : "";
    const lane = laneOf(laneKey);
    const startedImmediately = !lane.active && lane.queued.length === 0 && running < maxConcurrency;
    lane.queued.push(job);
    const position = lane.queued.length + (lane.active ? 1 : 0); // 1-based within the lane
    pump();
    return { accepted: true, deduped: false, position, startedImmediately };
  }

  function cancelActive(reason, laneKey) {
    let cancelled = false;
    for (const [key, lane] of lanes) {
      if (laneKey != null && key !== String(laneKey)) continue;
      if (lane.active) {
        lane.active.cancelled = true; // stop it from dedupe-blocking a same-key re-ask
        lane.active.controller.abort(reason || "cancelled");
        cancelled = true;
      }
    }
    return cancelled;
  }

  function size() {
    let total = 0;
    for (const lane of lanes.values()) total += lane.queued.length;
    return total;
  }
  function activeCount() {
    return running;
  }
  function idle() {
    if (running === 0 && size() === 0) return Promise.resolve();
    return new Promise((r) => idleResolvers.push(r));
  }

  return { enqueue, cancelActive, has, size, active: activeCount, idle };
}
