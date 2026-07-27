// Smoke-gate harness: mount a real surface, look at what it painted.
//
// WHY THIS LAYER EXISTS
// ---------------------
// On 2026-07-27 a workspace holding 8 agents rendered "No agents match — You
// haven't created any agents yet." over a full list, with no control on screen
// to undo it (a persisted `ownerFilter: 'mine'` filtered everything away, and
// the Mine/All toggle only rendered when the filter had matches). typecheck,
// eslint, vitest, the node suite and the build were ALL green. None of them
// render the app, so none of them could see it.
//
// The assertion this file makes possible is therefore not "it rendered". It is:
//
//     AN EMPTY STATE MUST NOT BE SHOWING WHILE DATA EXISTS.
//
// Every surface is handed N > 0 items and must show all N and none of its
// "nothing here" copy. A surface that renders its empty state with data in hand
// fails the run and says exactly which surface and what it saw.
//
// APPROACH: jsdom, real components, fixture props. No browser, no vite server,
// no login, no network, no database. See tests/smoke/README.md for why.

import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');

/** Where a failing surface dumps what it actually painted. */
export const FAILURE_DIR = join(REPO_ROOT, '.smoke-failures');

/** How many items every surface is seeded with. 8 is the incident's count. */
export const SEED_COUNT = 8;

// ---------------------------------------------------------------------------
// jsdom shims
//
// These are capabilities the components legitimately use that jsdom does not
// implement. Each one is a no-op or a fixed value — none of them fakes app
// behaviour, they only stop a missing browser API from throwing before the
// component has had a chance to paint (which would fail the run for the wrong
// reason).
// ---------------------------------------------------------------------------

type Mutable = Record<string, unknown>;

export function installDomShims(): void {
  const g = globalThis as unknown as Mutable;

  (g as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  if (typeof g.ResizeObserver === 'undefined') {
    g.ResizeObserver = class {
      observe() { }
      unobserve() { }
      disconnect() { }
    };
  }
  if (typeof g.IntersectionObserver === 'undefined') {
    g.IntersectionObserver = class {
      root = null;
      rootMargin = '';
      thresholds: number[] = [];
      observe() { }
      unobserve() { }
      disconnect() { }
      takeRecords() { return []; }
    };
  }
  if (typeof g.matchMedia === 'undefined') {
    g.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener() { },
      removeListener() { },
      addEventListener() { },
      removeEventListener() { },
      dispatchEvent() { return false; },
    });
  }
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => { };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => { };
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => { };
  if (!HTMLElement.prototype.scrollTo) HTMLElement.prototype.scrollTo = () => { };

  // OFFLINE, ALWAYS. The gate must never reach a network or a database, so
  // every outbound door is closed here rather than trusted not to be opened.
  // What replaces fetch is not a blanket stub but a ROUTER over seeded rows
  // (see `backend` below): surfaces that load their own data — Inbox, Tenants,
  // Memory — then run their real hook, real request, real parse, real render.
  g.fetch = smokeFetch;

  if (typeof g.indexedDB === 'undefined') g.indexedDB = new FakeIndexedDB();

  g.WebSocket = class {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 3;
    close() { }
    send() { }
    addEventListener() { }
    removeEventListener() { }
  };

  // jsdom has no PointerEvent; Radix listens for it. MouseEvent carries every
  // field the prober sets, so aliasing is enough.
  if (typeof g.PointerEvent === 'undefined') g.PointerEvent = MouseEvent;

  if (typeof g.EventSource === 'undefined') {
    g.EventSource = class {
      close() { }
      addEventListener() { }
      removeEventListener() { }
    };
  }
}

// ---------------------------------------------------------------------------
// The seeded backend
//
// `backendClient` posts every read to `/backend/db/select` with the table name
// in the body, and the bespoke routes (inbox, tenants) are plain GETs. Both are
// answered here from a registry the tests fill in. Nothing else is answered:
// an unregistered table returns an empty list, which is exactly what the real
// backend would return for a table with no rows.
// ---------------------------------------------------------------------------

export const backend = {
  /** table name -> rows, answered on POST /backend/db/select. */
  tables: new Map<string, unknown[]>(),
  /** URL substring -> the `data` payload of a GET route. */
  routes: new Map<string, unknown>(),
  reset() {
    this.tables.clear();
    this.routes.clear();
  },
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data, error: null }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function smokeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (url.includes('/backend/db/select')) {
    let table = '';
    let single = false;
    try {
      const body = JSON.parse(String(init?.body ?? '{}')) as { table?: string; single?: boolean };
      table = String(body.table || '');
      single = body.single === true;
    } catch { /* an unparseable body is an empty read */ }
    const rows = backend.tables.get(table) ?? [];
    return json(single ? (rows[0] ?? null) : rows);
  }

  // Longest match wins, so '/backend/tenants/<id>' can be registered alongside
  // '/backend/tenants' without the shorter one swallowing it.
  const hit = [...backend.routes.keys()]
    .filter(key => url.includes(key))
    .sort((a, b) => b.length - a.length)[0];
  if (hit !== undefined) return json(backend.routes.get(hit));

  return json([]);
}

// A minimal in-memory IndexedDB. `cachedFetch` writes every successful read
// through offlineDb, and jsdom ships no IndexedDB at all — without this the
// write rejects and the hook never commits the rows it just fetched, which
// would fail the gate for a reason that has nothing to do with the app.
type FakeRequest<T> = { result: T; error: null; onsuccess: (() => void) | null; onerror: (() => void) | null; onupgradeneeded?: (() => void) | null };

function fire<T>(result: T, upgrade?: () => void): FakeRequest<T> {
  const request: FakeRequest<T> = { result, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
  queueMicrotask(() => {
    if (upgrade) { request.onupgradeneeded?.(); }
    request.onsuccess?.();
  });
  return request;
}

class FakeIndexedDB {
  private stores = new Map<string, Map<unknown, unknown>>();
  open() {
    const stores = this.stores;
    const db = {
      objectStoreNames: { contains: (name: string) => stores.has(name) },
      createObjectStore: (name: string, opts?: { keyPath?: string }) => {
        stores.set(name, new Map());
        return { keyPath: opts?.keyPath };
      },
      transaction: (name: string) => ({
        objectStore: () => {
          const store = stores.get(name) ?? new Map();
          stores.set(name, store);
          return {
            put: (entry: Record<string, unknown>) => fire((store.set(entry.key ?? entry.id, entry), undefined)),
            add: (entry: Record<string, unknown>) => fire((store.set(store.size + 1, entry), undefined)),
            get: (key: unknown) => fire(store.get(key)),
            getAll: () => fire([...store.values()]),
            delete: (key: unknown) => fire((store.delete(key), undefined)),
            clear: () => fire((store.clear(), undefined)),
          };
        },
      }),
      close: () => { },
    };
    return fire(db, () => { });
  }
}

// ---------------------------------------------------------------------------
// Mounting
// ---------------------------------------------------------------------------

export interface Mounted {
  container: HTMLDivElement;
  /** Everything the surface put on screen, whitespace-collapsed. */
  text(): string;
  /** Clickable controls, in document order. */
  controls(): HTMLElement[];
  click(el: HTMLElement): Promise<void>;
  unmount(): void;
}

/**
 * What counts as a control a user could click to get out of a filter.
 *
 * Read against the whole DOCUMENT, not the mount container: a Radix dropdown or
 * select renders its items in a PORTAL on document.body, and the "All" option
 * that clears the inbox's unread filter lives there. A prober that only looked
 * inside the container would report that surface as unrecoverable — which it is
 * not — and a false failure in a pre-push gate is how gates get disabled.
 */
const CONTROL_SELECTOR = [
  'button',
  '[role="tab"]',
  '[role="option"]',
  '[role="menuitem"]',
  '[role="menuitemradio"]',
  '[role="menuitemcheckbox"]',
  '[role="radio"]',
  '[role="switch"]',
].join(', ');

/**
 * Mount a surface and let its effects settle.
 *
 * The double flush is deliberate: the first `act` paints, the second lets an
 * effect that kicked off a promise (a hook's initial load) resolve and re-render.
 * A surface asserted before that settles would report its LOADING state, which
 * is neither the empty state nor the populated one.
 */
export async function mount(element: ReactElement): Promise<Mounted> {
  const before = new Set(Array.from(document.body.children));
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  await act(async () => { await Promise.resolve(); });

  const mounted: Mounted = {
    container,
    text: () => (document.body.textContent || '').replace(/\s+/g, ' ').trim(),
    controls: () => Array.from(document.body.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)),
    click: async (el: HTMLElement) => {
      // The full sequence, not a bare click: Radix opens a dropdown or a select
      // on POINTERDOWN, so a click-only prober can never reach the option inside
      // one — and would call a recoverable surface a trap.
      await act(async () => {
        for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
          el.dispatchEvent(
            type.startsWith('pointer')
              ? new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, isPrimary: true })
              : new MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }),
          );
        }
        await Promise.resolve();
      });
      await act(async () => { await Promise.resolve(); });
    },
    unmount: () => {
      act(() => { root.unmount(); });
      container.remove();
      // Portalled menus/overlays are appended to body. Anything this mount added
      // and did not take away would otherwise be read as the NEXT mount's output.
      for (const node of Array.from(document.body.children)) {
        if (!before.has(node)) node.remove();
      }
    },
  };
  return mounted;
}

// ---------------------------------------------------------------------------
// The assertion that matters
// ---------------------------------------------------------------------------

export interface SurfaceProbe {
  /** Human name used in the failure line: "Agents", "Inbox", … */
  surface: string;
  /** Unique markers, one per seeded item. All must be on screen. */
  seeded: string[];
  /**
   * This surface's "nothing here" copy. Any of these showing while `seeded`
   * items exist is the incident's exact shape and fails the run.
   */
  emptyStates: string[];
}

class SmokeFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmokeFailure';
  }
}

/**
 * The gate. Throws a message a human can act on without opening a debugger.
 *
 * Cheapest equivalent of a screenshot in jsdom: the surface's rendered text is
 * written to `.smoke-failures/<surface>.txt` so the failure can be read rather
 * than reproduced.
 */
export function assertPopulated(mounted: Mounted, probe: SurfaceProbe): void {
  const text = mounted.text();
  const missing = probe.seeded.filter(marker => !text.includes(marker));
  const showingEmpty = probe.emptyStates.filter(copy => text.includes(copy));

  if (!missing.length && !showingEmpty.length) return;

  const total = probe.seeded.length;
  const visible = total - missing.length;
  const lines: string[] = [];

  if (showingEmpty.length) {
    lines.push(
      `${probe.surface}: empty state ${showingEmpty.map(c => `"${c}"`).join(' + ')} ` +
      `is showing with ${total} items seeded.`,
    );
  }
  if (missing.length) {
    lines.push(
      `${probe.surface}: ${visible} of ${total} seeded items rendered. ` +
      `Missing: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? `, +${missing.length - 5} more` : ''}.`,
    );
  }
  lines.push(dumpFailure(probe.surface, text));
  throw new SmokeFailure(lines.join('\n'));
}

/** Same reporting, for a check that is not a seeded-items count. */
export function smokeFail(surface: string, detail: string, mounted?: Mounted): never {
  const lines = [`${surface}: ${detail}`];
  if (mounted) lines.push(dumpFailure(surface, mounted.text()));
  throw new SmokeFailure(lines.join('\n'));
}

function dumpFailure(surface: string, text: string): string {
  const file = join(FAILURE_DIR, `${surface.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`);
  try {
    mkdirSync(FAILURE_DIR, { recursive: true });
    writeFileSync(file, text);
    return `  what it painted -> ${file}\n  first 400 chars: ${text.slice(0, 400)}`;
  } catch {
    return `  first 400 chars: ${text.slice(0, 400)}`;
  }
}

// ---------------------------------------------------------------------------
// Trap states
// ---------------------------------------------------------------------------

/**
 * Prove a stored preference cannot strand the user.
 *
 * Mounts the surface with a preference already written to localStorage that
 * filters every seeded item away, then either
 *   (a) the surface refuses the filter and shows the items anyway, or
 *   (b) SOME single control on screen, when clicked, brings them back.
 *
 * If neither holds, the user is stuck looking at an empty screen over a full
 * workspace with no way out — the incident — and the run fails.
 *
 * Controls are clicked one per fresh mount, so an earlier click can never
 * explain a later recovery. Every callback the fixtures pass is a no-op, so a
 * click cannot mutate anything.
 */
export async function assertRecoverable(
  surface: string,
  render: () => ReactElement,
  seeded: string[],
  options: { maxControls?: number } = {},
): Promise<{ recoveredBy: string }> {
  const cap = options.maxControls ?? 30;
  const stored = snapshotStorage();
  const shows = (m: Mounted) => seeded.every(marker => m.text().includes(marker));

  // Every attempt starts from the SAME stored preference. Without this the
  // probe is worthless: `usePersistedPreference` writes the new value back, so
  // attempt 4 would inherit whatever attempts 1-3 clicked and a control that
  // does clear the filter could be tried against a state it cannot clear.
  const fresh = async () => {
    restoreStorage(stored);
    return mount(render());
  };

  const first = await fresh();
  try {
    if (shows(first)) return { recoveredBy: '(filter yielded — items never hidden)' };
  } finally {
    first.unmount();
  }

  const probe = await fresh();
  const labels = probe.controls().slice(0, cap).map(controlLabel);
  probe.unmount();

  for (let i = 0; i < labels.length; i++) {
    const m = await fresh();
    try {
      const control = m.controls()[i];
      if (!control) continue;
      const openedBefore = new Set(m.controls());
      await m.click(control);
      if (shows(m)) return { recoveredBy: labels[i] || `control #${i}` };

      // The click opened something rather than doing something — a dropdown, a
      // select, a filter menu. The way out of the inbox's unread filter is an
      // option INSIDE such a menu, so follow one level down.
      const revealed = m.controls().filter(el => !openedBefore.has(el));
      for (const option of revealed.slice(0, cap)) {
        await m.click(option);
        if (shows(m)) {
          return { recoveredBy: `${labels[i] || `control #${i}`} > ${controlLabel(option)}` };
        }
      }
    } finally {
      m.unmount();
    }
  }

  const stuck = await fresh();
  try {
    smokeFail(
      surface,
      `TRAP STATE. A stored preference hides all ${seeded.length} seeded items and ` +
      `none of the ${labels.length} controls on screen brings them back. ` +
      `Controls offered: ${labels.filter(Boolean).join(' | ') || '(none)'}. ` +
      `This is unrecoverable from the UI and looks like data loss.`,
      stuck,
    );
  } finally {
    stuck.unmount();
    restoreStorage(stored);
  }
}

function snapshotStorage(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key !== null) out[key] = localStorage.getItem(key) ?? '';
  }
  return out;
}

function restoreStorage(snapshot: Record<string, string>): void {
  localStorage.clear();
  for (const [key, value] of Object.entries(snapshot)) localStorage.setItem(key, value);
}

function controlLabel(el: HTMLElement): string {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  const aria = el.getAttribute('aria-label') || el.getAttribute('title') || '';
  return (text || aria).slice(0, 40);
}
