'use strict';
/**
 * Source-text primitives shared by every language backend.
 *
 * All editing in this tool is "replace one byte range" — no reserialisation,
 * so formatting and comments outside the edited span never change. These are
 * the three operations that model needs.
 */

function splice(source, start, end, replacement) {
  return source.slice(0, start) + replacement + source.slice(end);
}

/** Indent of the line an offset starts on, or null when it is mid-line. */
function lineIndentBefore(source, offset) {
  let pos = offset;
  while (pos > 0 && /[ \t]/.test(source[pos - 1])) pos--;
  if (source[pos - 1] === '\n') return { pos, indent: source.slice(pos, offset) };
  return null;
}

/**
 * Re-indent a multi-line snippet for a new depth. A template lifted from
 * elsewhere carries that spot's indentation on every line but the first (the
 * first is positioned by the caller), so without this an inserted subtree
 * writes its children at the old depth.
 */
function reindent(text, indent) {
  const lines = text.split('\n');
  if (lines.length === 1) return text;
  let common = null;
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    const lead = /^[ \t]*/.exec(lines[i])[0];
    if (common === null || lead.length < common.length) common = lead;
  }
  if (common === null) return text;
  const rest = lines.slice(1).map((l) => (l.trim() ? indent + l.slice(common.length) : l));
  return [lines[0]].concat(rest).join('\n');
}

/**
 * Widen [start,end) to swallow one adjacent whitespace-only gap, preferring the
 * leading indent+newline so a removed element does not leave a blank line.
 */
function cutRange(source, start, end) {
  let s = start;
  while (s > 0 && /[ \t]/.test(source[s - 1])) s--;
  if (s > 0 && source[s - 1] === '\n') {
    let st = s - 1;
    if (st > 0 && source[st - 1] === '\r') st--;
    return { start: st, end };
  }
  if (s < start) return { start: s, end };
  let e = end;
  while (e < source.length && /[ \t]/.test(source[e])) e++;
  if (source[e] === '\n') return { start, end: e + 1 };
  return { start, end };
}

module.exports = { splice, lineIndentBefore, reindent, cutRange };
