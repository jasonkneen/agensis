// cn() now lives in @agensis/ui (packages/ui/src/lib/utils.ts) alongside the
// components that use it. Re-exported here so the 62 app files importing
// '@/lib/utils' keep working, and because this module remains the app's own
// util home for the text helpers below.
//
// Deep import, NOT the '@agensis/ui' barrel: the barrel re-exports all 57
// components, so pulling cn through it drags recharts, react-day-picker, vaul,
// embla and cmdk into the module graph of every one of those 62 files. Rollup
// tree-shakes them back out of the production bundle (verified: no 'recharts'
// string in dist/assets/*.js), but vite dev and vitest have no such step and
// paid ~1.4 MB of pre-bundled deps on the first import of cn.
export { cn } from '@agensis/ui/lib/utils'

/**
 * Strip HTML tags from a string, preserving text content.
 * Uses DOM parsing when available for accuracy, falls back to regex.
 */
export function stripHtml(html: string): string {
  if (typeof DOMParser !== 'undefined') {
    // H2: parse into an INERT document. `div.innerHTML = html` on a detached div
    // still kicks off subresource loads, so `<img src=x onerror=...>` and
    // `<svg><animate onbegin=...>` execute in the app's origin even though the
    // node is never attached. A DOMParser document loads nothing and runs
    // nothing, so hostile markup is only ever read as text here.
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return doc.body?.textContent || '';
  }
  // Regex fallback for non-browser environments
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Normalize text input by converting to lowercase and trimming whitespace.
 * Returns empty string for non-string inputs.
 */
export function normalizeTextInput(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}
