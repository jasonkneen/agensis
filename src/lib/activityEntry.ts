import { shortenPathsIn } from './shortPath';

/**
 * What one `activity_events` row should actually SAY on screen.
 *
 * Two things about the stored row make the raw columns unusable as-is:
 *
 *  * `metadata` arrives as a JSON **string**, not an object. Every writer binds
 *    `JSON.stringify(metadata)` to a `$n::jsonb` parameter, which postgres.js
 *    re-encodes, so the column holds a json string scalar (`jsonb_typeof` says
 *    `string` for all 2 627 rows currently in the table). Rendering it with
 *    `JSON.stringify(value, null, 2)` therefore produces one escaped line —
 *    `"{\"session_id\":\"924d…"` — instead of a pretty-printed object. Unwrap
 *    before displaying.
 *  * `title` is cut to 80 characters of message content by the server
 *    (`logMessageActivity`), and for an agent tool step those 80 characters are
 *    spent almost entirely on an absolute path prefix — the filename never
 *    makes it in. The FULL line survives inside `metadata.content`, so the
 *    display rebuilds from there and falls back to `title` only when it can't.
 *
 * Pure string/JSON work; no React, no DOM.
 */

/** Longest rebuilt line worth keeping — enough for a step line plus its path. */
const MAX_ENTRY_CHARS = 240;

/** Depth guard: the observed corruption is one extra encode, three is paranoia. */
const MAX_UNWRAPS = 3;

export interface ActivityEntrySource {
  event_type?: string | null;
  title?: string | null;
  metadata?: unknown;
}

/**
 * The row's metadata as a plain object, peeling however many JSON string wraps
 * the write path added. Returns `null` for anything that isn't an object once
 * unwrapped — an array, a bare number, unparseable text.
 */
export function activityMetadata(value: unknown): Record<string, unknown> | null {
  let current = value;
  for (let depth = 0; depth < MAX_UNWRAPS && typeof current === 'string'; depth += 1) {
    const text = current.trim();
    if (!text) return null;
    try {
      current = JSON.parse(text) as unknown;
    } catch {
      return null;
    }
  }
  if (!current || typeof current !== 'object' || Array.isArray(current)) return null;
  return current as Record<string, unknown>;
}

/**
 * Metadata rendered for the detail pane: pretty-printed when it unwraps to an
 * object, and otherwise the raw text exactly as stored — an unparseable value is
 * still evidence, and re-escaping it would only hide it a second time.
 */
export function activityMetadataText(value: unknown): string {
  const parsed = activityMetadata(value);
  if (parsed) return JSON.stringify(parsed, null, 2);
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  return JSON.stringify(value, null, 2);
}

/** True when there is something in metadata worth giving a panel to. */
export function hasActivityMetadata(value: unknown): boolean {
  const text = activityMetadataText(value).trim();
  return text !== '' && text !== '{}' && text !== '[]' && text !== 'null';
}

/**
 * The row's full, unshortened line — the tooltip text, and the input to
 * {@link activityEntryLabel}. Rebuilt from `metadata.content` for a chat/step
 * message (see the note above about `title` losing the filename), using the same
 * sender fallback the server used when it wrote the truncated title.
 */
export function activityEntryText(event: ActivityEntrySource | null | undefined): string {
  const stored = typeof event?.title === 'string' ? event.title : '';
  if (event?.event_type !== 'message_sent') return stored;

  const meta = activityMetadata(event?.metadata);
  const content = typeof meta?.content === 'string' ? meta.content.replace(/\s+/g, ' ').trim() : '';
  if (!content) return stored;

  const named = typeof meta?.sender_name === 'string' ? meta.sender_name.trim() : '';
  const sender = named || (meta?.role === 'user' ? 'You' : 'Agent');
  const full = `${sender}: ${content}`;
  return full.length > MAX_ENTRY_CHARS ? `${full.slice(0, MAX_ENTRY_CHARS - 1)}…` : full;
}

/** The same line with its paths shortened — what the row and the heading render. */
export function activityEntryLabel(event: ActivityEntrySource | null | undefined): string {
  return shortenPathsIn(activityEntryText(event));
}
