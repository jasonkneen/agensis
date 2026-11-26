// A document body, ready for the HTML contentEditable editor.
//
// The editor stores and edits HTML, but agents (MCP create_document, mirrored
// agent docs) write MARKDOWN. Fed straight into innerHTML, a markdown body read
// as one run-on paragraph of literal syntax: `# The Agent Loop An **agent
// loop** is…`, tables as pipes, code fences as backticks. A body with no HTML
// structure but clear markdown signals is converted; anything else passes
// through untouched, so an HTML document is byte-for-byte what was saved. The
// first edit then saves it back as HTML, which is the editor's format.
//
// `marked` is present because `mermaid` (a direct dependency) requires it and
// npm hoists it. It is not yet declared in package.json only because the
// shared checkout's package-lock.json has another session's uncommitted
// changes in the same block; declare it once those land.
import { marked } from 'marked';
import { sanitizeHtml } from './sanitize';

const HTML_STRUCTURE = /<\/?(p|div|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|pre|br|section|span|img|strong|em|b|i|blockquote|code|a|hr)\b[^>]*>/i;

const MARKDOWN_SIGNAL = new RegExp([
  String.raw`(^|\n)\s{0,3}#{1,6}\s+\S`, // heading
  String.raw`(^|\n)\s{0,3}(?:[-*+]|\d+\.)\s+\S`, // list item
  String.raw`(^|\n)\s{0,3}>\s+\S`, // blockquote
  String.raw`(^|\n)\s{0,3}(?:\x60{3}|~{3})`, // code fence
  String.raw`(^|\n)\s*\|.*\|\s*\n\s*\|?\s*:?-{3,}`, // table header + rule
  String.raw`\*\*[^*\n]+\*\*`, // bold
].join('|'));

export function looksLikeMarkdown(body: string): boolean {
  if (!body || HTML_STRUCTURE.test(body)) return false;
  return MARKDOWN_SIGNAL.test(body);
}

export function docBodyToHtml(body: string): string {
  if (!looksLikeMarkdown(body)) return body;
  const html = marked.parse(body, { async: false, gfm: true, breaks: false }) as string;
  return sanitizeHtml(html);
}
