/**
 * Shared "activity placeholder" detection: while an agent works, the daemon
 * posts (then updates in place) a message whose entire content is a bare
 * activity verb — "thinking…", "reading src/App.tsx", "searching" — before
 * the real reply streams in. Every surface that shows live agent status
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

export const ACTIVITY_STATUS_RE = new RegExp(
  `^(${ACTIVITY_VERBS.join('|')})[\\s\\w.,…]*$`,
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
