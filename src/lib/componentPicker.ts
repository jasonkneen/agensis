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

/** Fold picks into the message body — the only way the agent learns about them. */
export function buildPickContext(picks: ElementPick[]): string {
  if (picks.length === 0) return '';
  const lines = picks.map(p => {
    const bits = [`[#${p.index}] ${p.label}`];
    if (p.component && p.component !== p.label) bits.push(`(${p.component})`);
    let line = bits.join(' ');
    if (p.text) line += ` — "${p.text}"`;
    line += `\n    selector: ${p.selector}`;
    if (p.note.trim()) line += `\n    note: ${p.note.trim()}`;
    return line;
  });
  return ['[Picked elements]', ...lines].join('\n');
}
