import DOMPurify from 'dompurify';
import type { Config } from 'dompurify';

// Centralized HTML sanitization for every place the app renders user/AI/document
// HTML via innerHTML or restores persisted contenteditable content. The document
// editor is a rich-text contenteditable, so the allowlist intentionally covers
// formatting, links, images, tables and code — but never scripts, event handlers,
// embedded frames, forms, or javascript: URLs (DOMPurify drops those by default).
//
// NOTE: This is for *document / chat / markdown* content. Canvas applets are a
// separate, intentionally-full-HTML surface that runs sandboxed in an iframe and
// must NOT be routed through this helper — they have their own postMessage policy.

const RICH_TEXT_CONFIG: Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'span', 'div', 'section', 'article',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'ins', 'mark', 'small', 'sub', 'sup',
    'blockquote', 'pre', 'code', 'kbd', 'samp', 'var',
    'ul', 'ol', 'li', 'dl', 'dt', 'dd',
    'a', 'img',
    'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'caption', 'colgroup', 'col',
    'hr', 'figure', 'figcaption',
    // Interactive block tags the rich-text editor persists (sketch canvas,
    // AI-response panels, task-list checkboxes). These are inert structural
    // elements — DOMPurify still strips every event handler (on*), javascript:
    // URL, and <script>/<iframe>/<form>, so they can't execute anything; the
    // editor re-attaches behavior at runtime via delegated JS, not inline HTML.
    'canvas', 'textarea', 'button', 'input', 'label',
  ],
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class', 'id', 'lang', 'dir',
    'colspan', 'rowspan', 'scope', 'start', 'type', 'width', 'height',
    'target', 'rel', 'align', 'valign',
    // Attributes the editor's interactive blocks need (no handlers; DOMPurify
    // sanitizes `style` CSS and drops on* handlers regardless).
    'placeholder', 'checked', 'disabled', 'readonly', 'value', 'name', 'for',
    'rows', 'cols', 'contenteditable', 'style',
  ],
  // The editor leans on data-* hooks for blocks/markers; allow them.
  ALLOW_DATA_ATTR: true,
  // Belt-and-suspenders: never let these through even if added to the allowlist later.
  // (Note: the `style` ELEMENT stays forbidden; the style ATTRIBUTE is allowed and
  // CSS-sanitized by DOMPurify. <form>/<select> stay forbidden — no submission/native menus.)
  FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'select', 'link', 'meta', 'base'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|ftp):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
};

// Force safe target/rel on links so sanitized anchors can't be a tabnabbing vector.
let hookRegistered = false;
function ensureHook() {
  if (hookRegistered || typeof window === 'undefined') return;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
  hookRegistered = true;
}

/**
 * Sanitize rich-text/document HTML before assigning to innerHTML or persisting.
 * Strips scripts, event handlers, javascript: URLs, frames and forms.
 */
export function sanitizeHtml(dirty: string | null | undefined): string {
  if (!dirty) return '';
  ensureHook();
  return DOMPurify.sanitize(dirty, RICH_TEXT_CONFIG);
}

/**
 * Sanitize HTML pasted into the contenteditable editor. Same allowlist as
 * document content; call from an onPaste handler with text/html clipboard data.
 */
export function sanitizeClipboardHtml(dirty: string | null | undefined): string {
  return sanitizeHtml(dirty);
}

/**
 * Sanitize already-rendered markdown HTML (chat/AI streaming) before display.
 * Markdown source may contain raw HTML, so the rendered string must be cleaned.
 */
export function sanitizeMarkdownHtml(dirty: string | null | undefined): string {
  return sanitizeHtml(dirty);
}
