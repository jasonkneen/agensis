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
