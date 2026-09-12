// Component picker — the data model + DOM/React resolution behind the composer's
// "inspector" toggle. The picker lets a human point at a live element in the app
// ("this thing here") and attach a note, without taking a screenshot. Each pick
// serializes into the outgoing message so whichever agent reads the thread gets a
// precise reference: { index, label, selector, component, note }.
//
// This module is deliberately framework-light: it reads the React fiber only to
// recover a component *name* for the label, and never holds a fiber reference.

export type ElementPick = {
  /** Stable local id (for React keys / removal). */
  id: string;
  /** 1-based ordinal shown in the circled marker and the chip. */
  index: number;
  /** Human label — the React component name when we can read it, else the tag. */
  label: string;
  /** Best-effort CSS selector path back to the element. */
  selector: string;
  /** React component display name, when resolvable from the fiber. */
  component?: string;
  /** Short text of the element (trimmed) — helps disambiguate in the payload. */
  text?: string;
  /** The note the human typed in the popup. */
  note: string;
  /** Viewport-space rect captured at pick time; markers re-anchor off the live
   *  selector when possible and fall back to this. */
  rect: { x: number; y: number; width: number; height: number };
};

const FIBER_KEY_PREFIX = '__reactFiber$';

type MinimalFiber = {
  type?: unknown;
  return?: MinimalFiber | null;
};

function readFiber(el: Element): MinimalFiber | null {
  for (const key in el) {
    if (key.startsWith(FIBER_KEY_PREFIX)) {
      return (el as unknown as Record<string, MinimalFiber>)[key] ?? null;
    }
  }
  return null;
}

function fiberTypeName(type: unknown): string | null {
  if (!type) return null;
  if (typeof type === 'string') return null; // host tag (div/span) — not a component
  if (typeof type === 'function') {
    const fn = type as { displayName?: string; name?: string };
    return fn.displayName || fn.name || null;
  }
  if (typeof type === 'object') {
    // memo/forwardRef wrappers: { $$typeof, render|type, displayName }
    const obj = type as { displayName?: string; render?: unknown; type?: unknown };
    if (obj.displayName) return obj.displayName;
    if (obj.render) return fiberTypeName(obj.render);
    if (obj.type) return fiberTypeName(obj.type);
  }
  return null;
}

/** Walk up the fiber tree to the nearest named component. */
export function resolveComponentName(el: Element): string | undefined {
  let fiber = readFiber(el);
  let hops = 0;
  while (fiber && hops < 30) {
    const name = fiberTypeName(fiber.type);
    // Skip generated/lowercase internals; prefer a real PascalCase component.
    if (name && /^[A-Z]/.test(name)) return name;
    fiber = fiber.return ?? null;
    hops += 1;
  }
  return undefined;
}

function nthOfType(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i += 1;
    sib = sib.previousElementSibling;
  }
  return i;
}

/** Best-effort CSS path. Prefers id / data-testid, then a bounded tag:nth path. */
export function cssPath(el: Element): string {
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${cssEscape(testId)}"]`;
  if (el.id) return `#${cssEscape(el.id)}`;

  const parts: string[] = [];
  let node: Element | null = el;
  let depth = 0;
  while (node && node.nodeType === 1 && depth < 6) {
    const tag = node.tagName.toLowerCase();
    if (node.id) {
      parts.unshift(`#${cssEscape(node.id)}`);
      break;
    }
    const tid = node.getAttribute('data-testid');
    if (tid) {
      parts.unshift(`[data-testid="${cssEscape(tid)}"]`);
      break;
    }
    parts.unshift(`${tag}:nth-of-type(${nthOfType(node)})`);
    node = node.parentElement;
    depth += 1;
  }
  return parts.join(' > ');
}

// CSS.escape is present in all target browsers/Electron; guard for jsdom tests.
function cssEscape(value: string): string {
  const g = globalThis as { CSS?: { escape?: (v: string) => string } };
  if (g.CSS?.escape) return g.CSS.escape(value);
  return value.replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}

/** Resolve the identity fields for an element under the cursor. */
export function describeElement(el: Element): Pick<ElementPick, 'label' | 'selector' | 'component' | 'text'> {
  const component = resolveComponentName(el);
  const tag = el.tagName.toLowerCase();
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) || undefined;
  return {
    component,
    selector: cssPath(el),
    text,
    label: component || tag,
  };
}

/** The label line marker at the top of the block and each pick. */
const PICK_BLOCK_HEADER = '[Picked elements]';

/** Fold picks into the message body — the only way the agent learns about them. */
export function buildPickContext(picks: ElementPick[]): string {
  if (picks.length === 0) return '';
  const lines = picks.map(p => {
    const bits = [`[#${p.index}] ${p.label}`];
    if (p.component && p.component !== p.label) bits.push(`(${p.component})`);
    let line = bits.join(' ');
    if (p.text) line += ` — "${p.text}"`;
    line += `\n    selector: ${p.selector}`;
    if (p.note.trim()) {
      // The note comes from a multi-row textarea and may span several lines.
      // Emit the first line after `note:` and indent EVERY continuation line by
      // the same 4 spaces — including blank ones, which become a 4-space line.
      // That guarantees the block never contains a "\n\n", so the block/body
      // seam below stays unambiguous and parsePickContext can rejoin the note.
      const noteLines = p.note.trim().split('\n');
      line += `\n    note: ${noteLines[0]}`;
      for (const cont of noteLines.slice(1)) line += `\n    ${cont}`;
    }
    return line;
  });
  return [PICK_BLOCK_HEADER, ...lines].join('\n');
}

/** A pick recovered from a stored message body — the display counterpart to the
 *  full ElementPick the composer holds. Only the fields we render survive the
 *  round-trip through text (no id, rect or React fiber). */
export type ParsedPick = {
  index: number;
  label: string;
  component?: string;
  text?: string;
  selector?: string;
  note?: string;
};

/**
 * The inverse of buildPickContext, for the message renderer. A picked-element
 * message is stored as the labelled block, then a blank line, then whatever the
 * human actually typed:
 *
 *   [Picked elements]
 *   [#1] SendButton (Button) — "Send"
 *       selector: [data-testid="send"]
 *       note: make this bigger
 *
 *   the actual message text
 *
 * Returns the parsed picks and the remaining body so the renderer can draw the
 * picks as cards and hand the rest to markdown. When the content is not a picked
 * block at all, `picks` is empty and `body` is the content unchanged — every
 * ordinary message flows through untouched.
 */
export function parsePickContext(content: string): { picks: ParsedPick[]; body: string } {
  if (!content.startsWith(PICK_BLOCK_HEADER)) return { picks: [], body: content };

  // The composer joins the block to the body with exactly one blank line; the
  // block itself only ever uses single newlines, so the first "\n\n" is the
  // seam. Absent a body (a message that is only picks), everything is block.
  const seam = content.indexOf('\n\n');
  const blockText = seam === -1 ? content : content.slice(0, seam);
  const body = seam === -1 ? '' : content.slice(seam + 2);

  const picks: ParsedPick[] = [];
  let current: ParsedPick | null = null;
  // Once a `note:` field opens, following indented lines that are not another
  // recognised field are continuation lines of that (multiline) note.
  let noteOpen = false;
  for (const line of blockText.split('\n')) {
    const head = /^\[#(\d+)\]\s+(.*)$/.exec(line);
    if (head) {
      current = { index: Number(head[1]), ...parsePickLabel(head[2]) };
      picks.push(current);
      noteOpen = false;
      continue;
    }
    if (!current) continue; // the [Picked elements] header line, or stray text
    const selector = /^\s+selector:\s*(.*)$/.exec(line);
    if (selector) { current.selector = selector[1]; noteOpen = false; continue; }
    const note = /^\s+note:\s*(.*)$/.exec(line);
    if (note) { current.note = note[1]; noteOpen = true; continue; }
    if (noteOpen) {
      // Continuation of a multiline note — strip the 4-space indent that
      // buildPickContext added and rejoin with the newline it replaced.
      current.note = `${current.note ?? ''}\n${line.replace(/^ {4}/, '')}`;
      continue;
    }
  }
  return { picks, body };
}

/** Split a pick's label line — `Label (Component) — "text"` — into its parts. */
function parsePickLabel(rest: string): { label: string; component?: string; text?: string } {
  let working = rest;
  let text: string | undefined;
  const textMatch = / — "(.*)"$/.exec(working);
  if (textMatch) {
    text = textMatch[1];
    working = working.slice(0, textMatch.index);
  }
  let component: string | undefined;
  const compMatch = /\s+\(([^)]*)\)$/.exec(working);
  if (compMatch) {
    component = compMatch[1];
    working = working.slice(0, compMatch.index);
  }
  return { label: working.trim(), component, text };
}
