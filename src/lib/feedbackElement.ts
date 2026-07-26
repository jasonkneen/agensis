// ---------------------------------------------------------------------------
// Turning a clicked element into something a human can act on later.
//
// The picker records a reference, not a screenshot, so the reference has to
// survive the page being re-rendered, re-themed and re-deployed before anyone
// reads the report. That rules out the two obvious answers:
//
//   - Tailwind class chains. This codebase's class attributes are 300 chars of
//     utility classes that change on every restyle; a selector built from them
//     is stale on arrival.
//   - Raw `nth-child` paths from <html>. Correct for exactly one render of one
//     virtualised list.
//
// So the preference order is: stable id -> data-* hooks the codebase already
// uses as contracts (`data-slot`, `data-testid`, `data-workspace-viewport`,
// and the guided-tour selectors) -> aria-label -> tag + nth-of-type. We stop
// climbing the moment a segment is unique-by-construction (an id), which keeps
// selectors short and legible.
//
// PRIVACY: describeElement NEVER reads `value`, `defaultValue`, or the content
// of a password/email input. The text snippet is capped and redacted. A bug
// report about a login form must not carry what was typed into it.
// ---------------------------------------------------------------------------

import { redactSecrets } from './feedbackRedaction';

export interface ElementDescriptor {
  /** Best-effort CSS selector, re-queryable with document.querySelector. */
  selector: string;
  tag: string;
  /** Explicit role, or the implicit one for buttons/links/inputs. */
  role: string;
  /** Visible text, trimmed, capped and redacted. Never an input's value. */
  text: string;
  /** Viewport rect at pick time — orients the reader even if the selector rots. */
  rect: { x: number; y: number; width: number; height: number };
}

export const ELEMENT_TEXT_MAX_CHARS = 120;
/** How far up the tree a selector may climb before we accept a shorter, looser one. */
export const SELECTOR_MAX_DEPTH = 6;

/**
 * data-* attributes this codebase treats as contracts (the guided tour in
 * public/.well-known/cursorbuddy.json selects on several of them, and
 * tests/cursorbuddy-manifest.test.cjs pins them), so they are the most durable
 * hook available.
 */
const STABLE_DATA_ATTRIBUTES = [
  'data-testid',
  'data-test-id',
  'data-tour',
  'data-workspace-viewport',
  'data-window-id',
  'data-slot',
];

/**
 * Ids generated per-render are worse than useless in a selector: they look
 * authoritative and never match again. Radix emits `:r3:` / `radix-:r3:`, React
 * 18's useId emits `:R2ab:`, and both contain `:` which is not even legal in a
 * bare CSS id selector.
 */
export function isStableId(id: string): boolean {
  if (!id) return false;
  if (id.includes(':')) return false;
  if (/^radix-/i.test(id)) return false;
  if (/^(?:r|R)[0-9a-z]*$/.test(id)) return false;
  // Something that is mostly hex/uuid is a generated key, not a name.
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id)) return false;
  return /^[A-Za-z_][\w-]*$/.test(id);
}

function cssEscape(value: string): string {
  const globalWithEscape = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (typeof globalWithEscape.CSS?.escape === 'function') return globalWithEscape.CSS.escape(value);
  return value.replace(/["'\\\][{}()*+?.,^$|#\s/:]/g, '\\$&');
}

/** One selector segment for a single element, without its ancestors. */
function segmentFor(element: Element): { segment: string; unique: boolean } {
  const id = element.getAttribute('id') || '';
  if (isStableId(id)) return { segment: `#${cssEscape(id)}`, unique: true };

  const tag = element.tagName.toLowerCase();

  for (const attribute of STABLE_DATA_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value == null) continue;
    // Valueless marker attributes (`data-workspace-viewport`) select by presence.
    const segment = value === '' ? `${tag}[${attribute}]` : `${tag}[${attribute}="${value.replace(/"/g, '\\"')}"]`;
    return { segment, unique: false };
  }

  const label = element.getAttribute('aria-label');
  if (label && label.length <= 40) {
    return { segment: `${tag}[aria-label="${label.replace(/"/g, '\\"')}"]`, unique: false };
  }

  const role = element.getAttribute('role');
  if (role) return { segment: `${tag}[role="${role}"]`, unique: false };

  const parent = element.parentElement;
  if (!parent) return { segment: tag, unique: false };
  const siblings = Array.from(parent.children).filter(child => child.tagName === element.tagName);
  if (siblings.length <= 1) return { segment: tag, unique: false };
  return { segment: `${tag}:nth-of-type(${siblings.indexOf(element) + 1})`, unique: false };
}

/**
 * Build a CSS selector for `element`, climbing until a segment is unique or the
 * depth cap is hit. Returns '' for a detached or non-element node.
 */
export function cssSelectorForElement(element: Element | null): string {
  if (!element || typeof element.tagName !== 'string') return '';
  const parts: string[] = [];
  let current: Element | null = element;
  let depth = 0;

  while (current && depth < SELECTOR_MAX_DEPTH) {
    const tag = current.tagName.toLowerCase();
    if (tag === 'html' || tag === 'body') break;
    const { segment, unique } = segmentFor(current);
    parts.unshift(segment);
    if (unique) break;
    current = current.parentElement;
    depth += 1;
  }

  return parts.join(' > ');
}

/**
 * Visible text for the descriptor. Reads `textContent`, NOT `value` — an input
 * contributes its label or placeholder, never what the user typed.
 */
export function visibleTextFor(element: Element): string {
  const tag = element.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') {
    const labelled = element.getAttribute('aria-label')
      || element.getAttribute('placeholder')
      || element.getAttribute('name')
      || '';
    return labelled.trim().slice(0, ELEMENT_TEXT_MAX_CHARS);
  }
  const raw = (element.textContent || '').replace(/\s+/g, ' ').trim();
  if (raw.length <= ELEMENT_TEXT_MAX_CHARS) return raw;
  return `${raw.slice(0, ELEMENT_TEXT_MAX_CHARS)}…`;
}

function implicitRole(element: Element): string {
  const explicit = element.getAttribute('role');
  if (explicit) return explicit;
  switch (element.tagName.toLowerCase()) {
    case 'button': return 'button';
    case 'a': return element.hasAttribute('href') ? 'link' : '';
    case 'input': return element.getAttribute('type') === 'checkbox' ? 'checkbox' : 'textbox';
    case 'textarea': return 'textbox';
    case 'select': return 'combobox';
    case 'img': return 'img';
    default: return '';
  }
}

/** Full descriptor for one picked element. Safe to serialise into a report. */
export function describeElement(element: Element): ElementDescriptor {
  const rect = typeof element.getBoundingClientRect === 'function'
    ? element.getBoundingClientRect()
    : { x: 0, y: 0, width: 0, height: 0 };
  return {
    selector: cssSelectorForElement(element),
    tag: element.tagName.toLowerCase(),
    role: implicitRole(element),
    text: redactSecrets(visibleTextFor(element)),
    rect: {
      x: Math.round(rect.x ?? 0),
      y: Math.round(rect.y ?? 0),
      width: Math.round(rect.width ?? 0),
      height: Math.round(rect.height ?? 0),
    },
  };
}

/** Short human label for the chip shown in the form. */
export function elementChipLabel(descriptor: ElementDescriptor): string {
  const text = descriptor.text ? ` "${descriptor.text.slice(0, 28)}${descriptor.text.length > 28 ? '…' : ''}"` : '';
  return `<${descriptor.tag}>${text}`;
}
