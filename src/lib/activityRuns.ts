// Collapses the activity feed's repetition into runs you can drill into.
//
// The feed was a flat firehose: "@coder connected / @coder disconnected" eight
// times in a row read as eight separate pieces of news. A RUN is three or more
// consecutive events of the same family about the same subject (an agent's
// @handle, a message sender) with no gap longer than RUN_GAP_MS. It renders as
// one summary row — "@coder · connected 4 · disconnected 4 · 19:47–21:12" —
// that opens to the individual events.

export const RUN_MIN = 3;
export const RUN_GAP_MS = 2 * 60 * 60 * 1000;

export interface RunSource {
  id: string;
  created_at: string;
}

export interface ActivityRun<T extends RunSource> {
  key: string;
  subject: string;
  family: string;
  events: T[];
  /** e.g. [['connected', 4], ['disconnected', 4]] — most frequent first. */
  verbs: Array<[string, number]>;
  newest: string;
  oldest: string;
}

export type FeedItem<T extends RunSource> =
  | { kind: 'event'; event: T }
  | { kind: 'run'; run: ActivityRun<T> };

/**
 * The subject of a label and what happened to it. "@coder connected" ->
 * ['@coder', 'connected']; "Ada: shipped it" -> ['Ada', 'message']. A label
 * with no recognisable subject is never grouped.
 */
export function splitSubject(label: string, family: string): [string, string] | null {
  const text = label.trim();
  const handle = /^(@[\w.-]+)\s+(.+)$/.exec(text);
  if (handle) return [handle[1], handle[2].trim()];
  if (family === 'messages') {
    const sender = /^([^:]{1,40}):\s/.exec(text);
    if (sender) return [sender[1].trim(), 'message'];
  }
  return null;
}

export function groupActivityRuns<T extends RunSource>(
  events: T[],
  familyOf: (event: T) => string,
  labelOf: (event: T) => string,
): Array<FeedItem<T>> {
  const out: Array<FeedItem<T>> = [];
  let pending: { subject: string; family: string; items: Array<{ event: T; verb: string }> } | null = null;

  const flush = () => {
    if (!pending) return;
    if (pending.items.length >= RUN_MIN) {
      const counts = new Map<string, number>();
      for (const item of pending.items) counts.set(item.verb, (counts.get(item.verb) ?? 0) + 1);
      const evs = pending.items.map(item => item.event);
      out.push({
        kind: 'run',
        run: {
          key: `run:${evs[0].id}`,
          subject: pending.subject,
          family: pending.family,
          events: evs,
          verbs: [...counts].sort((a, b) => b[1] - a[1]),
          newest: evs[0].created_at,
          oldest: evs[evs.length - 1].created_at,
        },
      });
    } else {
      for (const item of pending.items) out.push({ kind: 'event', event: item.event });
    }
    pending = null;
  };

  for (const event of events) {
    const family = familyOf(event);
    const split = splitSubject(labelOf(event), family);
    const last = pending?.items[pending.items.length - 1]?.event;
    const gap = last ? Math.abs(Date.parse(last.created_at) - Date.parse(event.created_at)) : 0;
    if (pending && split && split[0] === pending.subject && family === pending.family && gap <= RUN_GAP_MS) {
      pending.items.push({ event, verb: split[1] });
      continue;
    }
    flush();
    if (split) pending = { subject: split[0], family, items: [{ event, verb: split[1] }] };
    else out.push({ kind: 'event', event });
  }
  flush();
  return out;
}
