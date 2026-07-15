// The markdown block parser, extracted from MarkdownContent.tsx.
//
// Pure string -> Block[]; no React, no DOM. It runs on every render of every
// rendered message, and re-runs on EVERY streamed token (the content grows, the
// useMemo key changes, the whole message is re-parsed from scratch), so it is on
// the hottest path in the app.
//
// TERMINATION INVARIANT — read before editing parseBlocks:
//
//   Every branch of the main loop must advance `i`. All of them do so
//   structurally except the paragraph branch, which is the fallthrough: its
//   break test fires on lines that look like a heading/list/fence marker so a
//   paragraph doesn't swallow the block that follows it.
//
//   That break test used to be able to fire on the FIRST line of the paragraph.
//   When it did, the branch pushed an empty paragraph and left `i` untouched —
//   an infinite loop that pushed empty blocks until the array length overflowed.
//   It was reachable from ordinary content: any line that is a marker with no
//   text after it ("- ", "## ", "1. ", "* ") matches the break test but none of
//   the branches above, because those all require content via `(.+)$`.
//
//   Streaming hit it constantly (a token boundary right after "- " is common in
//   any bulleted reply), and a persisted message containing such a line froze the
//   tab every single time that conversation was opened.
//
//   The `paragraph.length > 0` guard is what fixes it: the first line is always
//   consumed, so `i` always advances. Keep that guard. tests/unit/markdownBlocks.test.ts
//   covers every degenerate marker.

export type Block =
  | { type: 'code'; language: string; content: string }
  | { type: 'heading'; level: 1 | 2 | 3; content: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'blockquote'; content: string }
  | { type: 'table'; rows: string[][] }
  | { type: 'paragraph'; content: string };

export type FrontmatterValue = string | Record<string, string>;

export function splitTableRow(row: string) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

// Minimal flat-YAML frontmatter reader: a leading `---` block of `key: value`
// lines, with one level of 2-space-indented nesting (e.g. a `metadata:` object).
// Not a general YAML parser — matches the shape memory/doc files actually use.
export function parseFrontmatter(
  content: string,
): { meta: Record<string, FrontmatterValue>; body: string } | null {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines[0]?.trim() !== '---') return null;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { end = i; break; }
  }
  if (end === -1) return null;

  const meta: Record<string, FrontmatterValue> = {};
  let currentKey: string | null = null;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const nested = line.match(/^\s{2,}([\w.-]+):\s*(.*)$/);
    if (nested && currentKey) {
      const existing = meta[currentKey];
      const obj = typeof existing === 'object' && existing ? existing : {};
      obj[nested[1]] = nested[2].trim();
      meta[currentKey] = obj;
      continue;
    }

    const top = line.match(/^([\w.-]+):\s*(.*)$/);
    if (top) {
      currentKey = top[1];
      meta[currentKey] = top[2].trim();
    }
  }

  if (!meta.name && !meta.description) return null;
  const body = lines.slice(end + 1).join('\n').replace(/^\n+/, '');
  return { meta, body };
}

// During streaming the tail often ends mid-token (`**bold` with no closer yet),
// which would render as literal asterisks until the next delta arrives. Close the
// most common dangling markers on the last line so formatting appears as it streams.
// Only invoked while streaming — finished messages are rendered verbatim, so a
// legitimately-odd marker (e.g. "2 * 3") is never altered.
export function closeOpenMarkers(content: string): string {
  const text = content;
  // Inside an open code fence: the block parser already renders the remainder as
  // code, so leave it untouched.
  if (((text.match(/^```/gm) || []).length) % 2 === 1) return text;

  const nlIndex = text.lastIndexOf('\n');
  const head = nlIndex === -1 ? '' : text.slice(0, nlIndex + 1);
  let tail = nlIndex === -1 ? text : text.slice(nlIndex + 1);

  if (((tail.match(/`/g) || []).length) % 2 === 1) {
    tail += '`';
  } else if (((tail.match(/\*\*/g) || []).length) % 2 === 1) {
    tail += '**';
  }
  return head + tail;
}

const FENCE_RE = /^```/;
const HEADING_MARKER_RE = /^(#{1,3})\s+/;
const LIST_MARKER_RE = /^(\s*)([-*]|\d+\.)\s+/;

export function parseBlocks(content: string): Block[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const language = fence[1] || '';
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', language, content: code.join('\n') });
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      blocks.push({
        type: 'heading',
        level: heading[1].length as 1 | 2 | 3,
        content: heading[2],
      });
      i += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quote.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({ type: 'blockquote', content: quote.join('\n') });
      continue;
    }

    const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[2]);
      const items: string[] = [];
      while (i < lines.length) {
        const item = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.+)$/);
        if (!item || /\d+\./.test(item[2]) !== ordered) break;
        items.push(item[3]);
        i += 1;
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }

    if (
      line.includes('|') &&
      i + 1 < lines.length &&
      /^\s*\|?[\s:-]+\|[\s|:-]+\s*$/.test(lines[i + 1])
    ) {
      const rows: string[][] = [splitTableRow(line)];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitTableRow(lines[i]));
        i += 1;
      }
      blocks.push({ type: 'table', rows });
      continue;
    }

    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim()) {
      // `paragraph.length > 0` is load-bearing — see the TERMINATION INVARIANT at
      // the top of this file. Without it, a marker-only line ("- ", "## ") breaks
      // on the first iteration, `i` never advances, and this loop never ends.
      if (
        paragraph.length > 0 &&
        (FENCE_RE.test(lines[i]) ||
          HEADING_MARKER_RE.test(lines[i]) ||
          LIST_MARKER_RE.test(lines[i]))
      ) {
        break;
      }
      paragraph.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'paragraph', content: paragraph.join('\n') });
  }

  return blocks;
}
