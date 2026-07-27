// Message attachments — the pure half.
//
// A message carries `attachments`: a jsonb array of REFERENCES to
// `uploaded_files` rows ({ id, name, type, size }). Never file bytes. The row
// is what gets rendered — an image inline, anything else as a download chip.
//
// Everything except `id` is CLIENT-SUPPLIED metadata that came off somebody's
// file picker and was written straight to the DB. So it is untrusted on the way
// back out:
//
//   - `name` is display text and a download filename. It is stripped of control
//     characters and of the bidi OVERRIDE/EMBED/ISOLATE codepoints (the
//     "report.txt" that is really "report.exe" trick), collapsed to one line and
//     length-capped so it cannot break a chip's layout. It is rendered as text,
//     never as HTML.
//   - `type` decides ONLY which of the two renderers runs. It is matched against
//     a closed allowlist of raster image types, so an unexpected value falls
//     back to the chip rather than to an <img>. It is never used for anything
//     security-relevant — the bytes are served by the authenticated file route,
//     which sets its own Content-Type from the stored row.
//   - `size` is display text.
//
// The list itself is capped, deduped by id, and drops any entry without a
// usable id — a message cannot smuggle a thousand chips into a transcript.
//
// This module is deliberately free of React and of `backendClient`, so the
// decisions in it (what is an image, how a list parses, what a missing file
// renders as) are testable without a DOM. See tests/unit/messageAttachments.test.ts.

import type { MessageAttachment } from '../types';

export type { MessageAttachment };

/** Hard cap on chips per message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 20;

/** Display cap for a file name, in characters. */
export const ATTACHMENT_NAME_MAX = 80;

/** Shown when the name is missing or nothing survives sanitisation. */
export const UNNAMED_ATTACHMENT_LABEL = 'Untitled file';

/**
 * Shown when the `uploaded_files` row is gone (deleted file, wrong workspace,
 * revoked access). An honest sentence beats a broken-image glyph.
 */
export const ATTACHMENT_UNAVAILABLE_LABEL = 'File unavailable';

// Raster image types a browser renders safely inside an <img>. Deliberately a
// CLOSED list rather than a `type.startsWith('image/')` test:
//
//   image/svg+xml is an image by prefix and a scriptable document in fact. It
//   is not here, so an SVG attachment renders as a download chip — downloading
//   it cannot execute anything, whereas handing it to a viewer could.
//
// Anything unrecognised lands on the chip too, which is the safe default.
const INLINE_IMAGE_TYPES = new Set([
  'image/apng',
  'image/avif',
  'image/bmp',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);

// C0/C1 controls (newlines included — a chip is one line) and the bidi
// OVERRIDE / EMBEDDING / ISOLATE controls. U+200E/U+200F (LRM/RLM) are left
// alone: they are ordinary marks in real right-to-left filenames and cannot
// re-order the text around them the way an override can.
// Matching control characters is the POINT here, so the rule is off for this
// line rather than the class being narrowed to satisfy it.
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = new RegExp('[\\u0000-\\u001F\\u007F-\\u009F\\u202A-\\u202E\\u2066-\\u2069]', 'g');

// A MIME type with no parameters. Anything outside this shape is discarded
// rather than carried around as a half-trusted string.
const MIME_TYPE_RE = /^[a-z0-9][a-z0-9!#$&^_+-]{0,60}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,60}$/;

/**
 * Clean a client-supplied file name down to one short line of plain text.
 * Always returns something printable — never an empty string.
 */
export function safeAttachmentName(value: unknown): string {
  if (typeof value !== 'string') return UNNAMED_ATTACHMENT_LABEL;
  // Whitespace FIRST, then the remaining unsafe codepoints. Newlines and tabs
  // are control characters too, so stripping in the other order glues the words
  // either side of a line break together ("report\nfinal" -> "reportfinal").
  const collapsed = value
    .replace(/\s+/g, ' ')
    .replace(UNSAFE_NAME_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return UNNAMED_ATTACHMENT_LABEL;
  if (collapsed.length <= ATTACHMENT_NAME_MAX) return collapsed;
  return `${collapsed.slice(0, ATTACHMENT_NAME_MAX - 1).trimEnd()}…`;
}

/**
 * Normalise a client-supplied MIME type: lowercased, parameters dropped, and
 * discarded entirely unless it looks like a type. Returns '' when unusable,
 * which routes the attachment to the download chip.
 */
export function safeAttachmentType(value: unknown): string {
  if (typeof value !== 'string') return '';
  const base = value.split(';')[0].trim().toLowerCase();
  return MIME_TYPE_RE.test(base) ? base : '';
}

/** Byte count for display. Anything that is not a sane number becomes 0. */
export function safeAttachmentSize(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(size) || size <= 0) return 0;
  return Math.floor(size);
}

/** True when this attachment should render as an inline thumbnail. */
export function isImageAttachment(attachment: { type?: string | null } | null | undefined): boolean {
  if (!attachment) return false;
  return INLINE_IMAGE_TYPES.has(safeAttachmentType(attachment.type));
}

/**
 * Read `messages.attachments` into a list that is safe to render.
 *
 * Tolerant on the way in because the same column reaches us three ways: as a
 * parsed jsonb array from the Fly server, as a JSON string from a driver that
 * does not parse, and as whatever an older row happens to hold (null, `{}`,
 * a stray scalar). None of those may throw at render time.
 */
export function parseMessageAttachments(value: unknown): MessageAttachment[] {
  let list: unknown = value;
  if (typeof list === 'string') {
    const text = list.trim();
    if (!text) return [];
    try {
      list = JSON.parse(text);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(list)) return [];

  const out: MessageAttachment[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    if (out.length >= MAX_ATTACHMENTS_PER_MESSAGE) break;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    // The id is the only field the server acts on, so it is the only one whose
    // absence disqualifies the entry.
    const id = typeof record.id === 'string' ? record.id.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: safeAttachmentName(record.name),
      type: safeAttachmentType(record.type),
      size: safeAttachmentSize(record.size),
    });
  }
  return out;
}

/**
 * Build the stored list from the composer's linked-file chips. Only UPLOADED
 * files qualify: a "project" file is a path on somebody's machine that this app
 * cannot fetch, so it has no thumbnail to offer and stays text-only.
 */
export function buildMessageAttachments(
  files: Array<{ kind?: string; fileId?: string | null; name?: string | null; mimeType?: string | null; size?: number | null }>,
): MessageAttachment[] {
  if (!Array.isArray(files)) return [];
  const rows = files
    .filter(file => Boolean(file) && file.kind === 'uploaded' && typeof file.fileId === 'string' && file.fileId.trim() !== '')
    .map(file => ({ id: String(file.fileId), name: file.name, type: file.mimeType, size: file.size }));
  // Reuse the read-side parser so a chip built in the composer and a chip read
  // back from the DB can never disagree about what is renderable.
  return parseMessageAttachments(rows);
}

/** Path of the authenticated route that serves an attachment's bytes. */
export function attachmentContentPath(id: string): string {
  return `/backend/files/${encodeURIComponent(id)}/content`;
}

// ---------------------------------------------------------------------------
// Thumbnail sizing.
//
// An attachment in a transcript is a REFERENCE to a file, not the file itself.
// Rendering it big enough to read turns one message into a page: a 2560x1440
// screenshot at the old 256px bound is taller than the composer, so two of them
// in a row push the conversation off screen in a floating window.
//
// So the transcript gets a thumbnail and the modal gets the picture. The bound
// is HEIGHT-first (120px): chat scrolls vertically, so height is the axis that
// costs a reader, and a 120px-tall thumbnail is still large enough to recognise
// a screenshot from. Width is capped too (240px) so a panorama cannot occupy a
// whole row on its own.
//
// The box is computed from the image's INTRINSIC dimensions rather than left to
// `max-height` on the <img>, because the button needs a size before the bytes
// arrive — an <img> that grows from nothing to 120px when the blob resolves
// reflows every message below it, and each message row carries
// `content-visibility: auto` with a remembered intrinsic size, which reflows
// worst of all. Reserving the box up front means loading changes the picture,
// not the layout.
// ---------------------------------------------------------------------------

/** Widest a thumbnail may render, in CSS pixels. */
export const ATTACHMENT_THUMB_MAX_WIDTH = 240;

/** Tallest a thumbnail may render, in CSS pixels. This is the bound that matters. */
export const ATTACHMENT_THUMB_MAX_HEIGHT = 120;

/**
 * The box reserved before the bytes arrive, and whenever an image reports no
 * usable intrinsic size. 4:3 at the full height bound — the shape a screenshot
 * is most likely to land near, so the common case barely moves on load.
 */
export const ATTACHMENT_THUMB_PLACEHOLDER: Readonly<{ width: number; height: number }> = Object.freeze({
  width: 160,
  height: ATTACHMENT_THUMB_MAX_HEIGHT,
});

/**
 * Fit an image's intrinsic dimensions inside the thumbnail bound, preserving
 * aspect ratio.
 *
 * Never UPSCALES: a 32x32 icon rendered 120px tall is a blurry lie about what
 * somebody uploaded, and stretching it wastes the row it sits in. Anything that
 * is not a pair of positive finite numbers (an image that failed to decode, a
 * jsdom <img> with no layout, a hostile `0`) falls back to the placeholder box
 * rather than producing a zero-sized or NaN-sized control.
 */
export function attachmentThumbnailBox(
  naturalWidth: unknown,
  naturalHeight: unknown,
): { width: number; height: number } {
  const width = typeof naturalWidth === 'number' ? naturalWidth : Number(naturalWidth);
  const height = typeof naturalHeight === 'number' ? naturalHeight : Number(naturalHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { ...ATTACHMENT_THUMB_PLACEHOLDER };
  }
  const scale = Math.min(
    ATTACHMENT_THUMB_MAX_WIDTH / width,
    ATTACHMENT_THUMB_MAX_HEIGHT / height,
    1,
  );
  return {
    // A sub-pixel result still has to be a clickable control, so both axes
    // floor at 1 rather than rounding to 0.
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/**
 * What an image attachment can show right now. ONE decision shared by the
 * thumbnail and the modal, so the two can never disagree about whether the file
 * is there — the modal showing a broken image over a thumbnail that already
 * said "File unavailable" is exactly the split this prevents.
 */
export type AttachmentPreviewState = 'ready' | 'loading' | 'unavailable';

export function attachmentPreviewState(status: {
  src?: string | null;
  loading?: boolean;
  error?: boolean;
}): AttachmentPreviewState {
  // Error wins over a stale src: the hook clears the object URL before it
  // refetches, but a caller that held on to one must still show the failure.
  if (status?.error) return 'unavailable';
  if (status?.src) return 'ready';
  return 'loading';
}

// buildFileContext (components/chat/ComposerAddContent.tsx) folds a
// "[Linked files]" block into the message CONTENT so the agent reading the turn
// knows a file came with it. That block stays — it is the agent's only view of
// an attachment.
//
// Once a message also carries structured `attachments`, showing the bullet list
// AND the chips is the duplication this feature exists to remove. So the block
// is stripped FROM THE DISPLAY ONLY, and only for the uploaded lines that a
// chip actually replaces: a "project" file line has no chip, so it stays.
//
// The stored content is never touched. A message with no attachments is never
// passed through here, so rows written before this column existed keep their
// text exactly as they always rendered it.
const LINKED_FILES_BLOCK = /\[Linked files\]\n((?:- .*(?:\n|$))+)/;
const UPLOADED_FILE_LINE = /\(Uploaded file\): /;

export function stripUploadedFileLinesFromDisplay(content: string): string {
  if (typeof content !== 'string') return '';
  const match = content.match(LINKED_FILES_BLOCK);
  if (!match) return content;
  const kept = match[1].split('\n').filter(line => line && !UPLOADED_FILE_LINE.test(line));
  const replacement = kept.length > 0 ? `[Linked files]\n${kept.join('\n')}\n` : '';
  const start = match.index ?? 0;
  // The block ends on its last bullet's newline, so the blank line that
  // separated it from the message body is still ahead. Dropping the block
  // whole means closing that seam too, or the text below gains a blank line
  // for every send (visible when canvas context put something above it).
  const rest = replacement ? content.slice(start + match[0].length) : content.slice(start + match[0].length).replace(/^\n/, '');
  return `${content.slice(0, start)}${replacement}${rest}`.replace(/^\n+/, '');
}
