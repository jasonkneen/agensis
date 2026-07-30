/**
 * Shared "activity placeholder" detection: while an agent works, the daemon
 * posts (then updates in place) a message whose entire content is a bare
 * activity verb — "thinking…", "reading the schema", "searching" — before
 * the real reply streams in. (A verb line carrying a PATH, like
 * "reading src/App.tsx", has never matched: `/` is outside the character class
 * below. Pinned in tests/unit/toolSteps.test.ts rather than changed, because
 * widening the class means swallowing more prose.) Every surface that shows
 * live agent status
 * (chat windows, sub-threads, the sidebar status feed) parses that same shape,
 * so the verb list and regex live here once instead of being copy-pasted.
 * Ordered longest-first so "looking up" matches before "looking".
 */
export const ACTIVITY_VERBS = [
  'looking up', 'summarizing', 'reviewing', 'reasoning', 'processing',
  'generating', 'executing', 'analyzing', 'searching', 'fetching',
  'planning', 'reading', 'editing', 'writing', 'checking', 'running',
  'browsing', 'thinking',
] as const;

export type ActivityVerb = (typeof ACTIVITY_VERBS)[number];

// A status line is a bare verb and maybe a short detail: "thinking",
// "Thinking 1m 4s", "reading src/App.tsx". It is NEVER a finished sentence —
// which is why the trailing lookbehind is here and not a nicety.
//
// Without it these eighteen verbs swallow the fastest thing an agent can say. In
// a live huddle the agent is told to open with one short acknowledgement so the
// listener hears something within a few hundred milliseconds, and the natural
// forms of that are "Checking the deploy now.", "Running that now.", "Looking up
// the last commit." — all of which matched, so every one of them was classified
// as a placeholder: never spoken aloud, and drawn in the chat as a "Checking…"
// chip rather than as the message it was. The reply the whole latency budget was
// built around was the one reply that could not get out.
//
// `…` stays allowed at the end, because that is exactly what a status line ends
// with; `.`, `!` and `?` are prose. server/index.cjs learned this same lesson on
// its own side — see PLACEHOLDER_CONTENT_RE, "deliberately narrower than a bare
// ^Thinking" — and this is that fix applied to the eighteen-verb shape.
export const ACTIVITY_STATUS_RE = new RegExp(
  `^(${ACTIVITY_VERBS.join('|')})[\\s\\w.,…]*(?<![.!?])$`,
  'i',
);

export function extractActivityVerb(content: string): string {
  const lower = content.trim().toLowerCase();
  for (const verb of ACTIVITY_VERBS) {
    if (lower.startsWith(verb)) return verb;
  }
  return 'thinking';
}

export function isActivityPlaceholderMessage(
  msg: { sender_kind?: string | null; role?: string | null; content?: unknown },
): boolean {
  if (!(msg.sender_kind === 'agent' || msg.role === 'assistant')) return false;
  const content = typeof msg.content === 'string' ? msg.content : '';
  return ACTIVITY_STATUS_RE.test(content.trim());
}

/**
 * "reading src/App.tsx" -> "Reading src/App.tsx…" for a short, human status line.
 *
 * "thinking" is the generic fallback verb (see `extractActivityVerb`) and
 * carries no differentiating detail — the daemon re-posts it as a heartbeat
 * roughly once a second while the model reasons, and that heartbeat's content
 * wobbles by trailing punctuation/whitespace alone. Pin it to one fixed
 * string so surfaces don't re-render/retype on every tick; verbs with real
 * detail (reading a path, editing a file) still reflect their content.
 */
export function activityLine(verb: string, content: string): string {
  if (verb === 'thinking') return 'Thinking…';
  const capitalized = verb.charAt(0).toUpperCase() + verb.slice(1);
  const rest = content.trim().slice(verb.length).trim();
  return rest ? `${capitalized} ${rest}…` : `${capitalized}…`;
}

// The server writes the heartbeat as `Thinking ${formatElapsedMs(...)}` — "0s",
// "43s", "1m 4s" — and nothing else. Matching that shape exactly means prose that
// merely opens with the word "thinking" can never be mistaken for a duration.
const THINKING_ELAPSED_RE = /^thinking\s+((?:\d+m\s+)?\d+s)$/i;

/** "Thinking 1m 4s" -> "1m 4s". Empty when the placeholder carries no duration. */
export function activityElapsed(content: string): string {
  const match = THINKING_ELAPSED_RE.exec(content.trim());
  return match ? match[1].replace(/\s+/g, ' ') : '';
}

/**
 * Label for the LIVE chip. Unlike `activityLine` — which pins "thinking" to one
 * fixed string so the sidebar status feed doesn't retype once a second — the chip
 * is the one surface that exists to show the clock, so it keeps the elapsed.
 */
export function activityChipLabel(content: string): string {
  const elapsed = activityElapsed(content);
  if (elapsed) return `Thinking ${elapsed}`;
  return activityLine(extractActivityVerb(content), content);
}

/** The same period once it's over: "1m 4s" -> "Thought for 1m 4s". */
export function thoughtChipLabel(elapsed: string): string {
  return `Thought for ${elapsed}`;
}

/**
 * How long a row may go without a sign of life before every surface must read it
 * as abandoned rather than in flight.
 *
 * Deliberately generous: the timestamps below are the SERVER's and are compared
 * against the BROWSER's, so a minute of slack keeps ordinary clock skew from
 * declaring a genuinely live run dead on sight.
 */
export const ACTIVITY_STALE_MS = 60000;

const ELAPSED_PART_RE = /(\d+)\s*([ms])/g;

/** "1m 4s" -> 64000. Zero for anything that is not one of the server's durations. */
export function parseElapsedMs(elapsed: string): number {
  let total = 0;
  let matched = false;
  ELAPSED_PART_RE.lastIndex = 0;
  for (let part = ELAPSED_PART_RE.exec(elapsed); part; part = ELAPSED_PART_RE.exec(elapsed)) {
    matched = true;
    total += Number(part[1]) * (part[2] === 'm' ? 60000 : 1000);
  }
  return matched ? total : 0;
}

/**
 * When this row was last known to be alive, in epoch ms — `NaN` when it carries
 * no usable clock at all, which callers read as "assume live".
 *
 * `created_at` is the INSERT time and never moves again: the daemon rewrites a
 * placeholder's content about once a second, but no column records that, so a
 * turn that reasons for ten minutes without a single tool call would read as
 * dead after one. The elapsed baked into the content is that missing clock —
 * "Thinking 2m 11s" means the daemon was still counting 2m11s into the run — so
 * a live placeholder's seen-at keeps pace with the wall clock while an abandoned
 * one freezes where it stopped.
 *
 * The elapsed is the JOB's, not this row's, so a placeholder that appeared
 * part-way through a turn overshoots by however long the turn had already been
 * running. That errs generous, in the same direction as the slack above.
 */
export function activitySeenAtMs(
  message: { created_at?: string | null; content?: unknown } | null | undefined,
): number {
  const created = message?.created_at ? new Date(message.created_at).getTime() : Number.NaN;
  if (!Number.isFinite(created)) return Number.NaN;
  const content = typeof message?.content === 'string' ? message.content : '';
  return created + parseElapsedMs(activityElapsed(content));
}

/**
 * An activity placeholder that could still be describing work happening NOW.
 *
 * A placeholder is only ever a claim about the present tense — "@coder is
 * thinking" — so one whose run demonstrably ended must stop making it. Some are
 * left behind for good when a job dies mid-turn, and those would otherwise
 * announce an agent at work forever.
 */
export function isLiveActivityPlaceholder(
  msg: { sender_kind?: string | null; role?: string | null; content?: unknown; created_at?: string | null },
  now: number = Date.now(),
): boolean {
  if (!isActivityPlaceholderMessage(msg)) return false;
  const seenAt = activitySeenAtMs(msg);
  if (!Number.isFinite(seenAt)) return true; // no usable clock — assume still live
  return now - seenAt <= ACTIVITY_STALE_MS;
}
