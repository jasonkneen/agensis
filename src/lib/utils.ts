import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

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
