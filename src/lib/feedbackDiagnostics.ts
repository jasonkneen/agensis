// ---------------------------------------------------------------------------
// Diagnostics capture for in-app feedback.
//
// "Attach my console logs" only works if something was listening BEFORE the bug
// happened, so this installs at app startup (src/main.tsx) rather than when the
// feedback dialog opens. That makes it a permanent, always-on tap on `console`
// in every session, which sets two hard constraints:
//
//   1. It must be BOUNDED. A chatty session (this app streams agent tokens and
//      ticks a daemon heartbeat every second) would otherwise grow a log array
//      until the tab dies. Hence a fixed-size ring buffer: newest N entries,
//      each truncated, oldest silently dropped.
//   2. It must never break the page. Capture is wrapped so a formatting failure
//      cannot take down the original console call, and the original method is
//      always invoked.
//
// What is deliberately NOT captured: localStorage, sessionStorage, cookies,
// form values, or network bodies. The session token lives in localStorage, and
// the cheapest way to guarantee it never reaches a report is to never read it.
// Console strings still get run through redactSecrets on the way out (see
// buildDiagnosticsSnapshot) because a log line can contain anything.
// ---------------------------------------------------------------------------

import { redactSecrets } from './feedbackRedaction';

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug';

export interface ConsoleEntry {
  level: ConsoleLevel;
  /** Already-truncated text. Redaction happens at snapshot time, not capture time. */
  message: string;
  /** Epoch ms. */
  at: number;
}

export interface ErrorEntry {
  kind: 'error' | 'unhandledrejection';
  message: string;
  source: string;
  at: number;
}

export interface DiagnosticsSnapshot {
  buildId: string;
  userAgent: string;
  url: string;
  viewport: { width: number; height: number };
  language: string;
  capturedAt: string;
  console: ConsoleEntry[];
  errors: ErrorEntry[];
  /** True when the ring buffer dropped older entries — the report is a tail, not the whole session. */
  truncated: boolean;
}

/** Entries kept. ~300 lines is a couple of minutes of real usage and a few hundred KB at most. */
export const CONSOLE_BUFFER_SIZE = 300;
/** Per-entry character cap. A single streamed agent message can be megabytes. */
export const CONSOLE_ENTRY_MAX_CHARS = 800;
export const ERROR_BUFFER_SIZE = 30;

export interface RingBuffer<T> {
  push: (item: T) => void;
  toArray: () => T[];
  clear: () => void;
  /** Total pushes ever — compare with size to know whether anything was dropped. */
  readonly pushed: number;
  readonly size: number;
  readonly capacity: number;
}

/**
 * Fixed-capacity FIFO. Overwrites in place, so memory is flat regardless of how
 * long the tab has been open. Pure — no globals, no DOM.
 */
export function createRingBuffer<T>(capacity: number): RingBuffer<T> {
  const max = Math.max(1, Math.floor(capacity));
  const items: T[] = [];
  let next = 0;
  let pushed = 0;

  return {
    push(item: T) {
      pushed += 1;
      if (items.length < max) {
        items.push(item);
        next = items.length % max;
        return;
      }
      items[next] = item;
      next = (next + 1) % max;
    },
    toArray() {
      if (items.length < max) return items.slice();
      // Oldest entry is at `next` once the buffer has wrapped.
      return items.slice(next).concat(items.slice(0, next));
    },
    clear() {
      items.length = 0;
      next = 0;
      pushed = 0;
    },
    get pushed() { return pushed; },
    get size() { return items.length; },
    get capacity() { return max; },
  };
}

/**
 * Render one console argument to a bounded string. Pure.
 *
 * Errors keep their stack (that is the useful part of a bug report); plain
 * objects are JSON-stringified with a cycle-safe replacer; anything that
 * refuses to serialise degrades to its type name rather than throwing.
 */
export function formatConsoleArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (arg === null) return 'null';
  if (arg === undefined) return 'undefined';
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ''}`;
  if (typeof arg === 'function') return `[Function ${arg.name || 'anonymous'}]`;
  if (typeof arg !== 'object') return String(arg);
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(arg, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    }) ?? String(arg);
  } catch {
    return '[Unserializable]';
  }
}

/** Join console arguments and clamp. Pure. */
export function formatConsoleArgs(args: unknown[], maxChars = CONSOLE_ENTRY_MAX_CHARS): string {
  const joined = args.map(formatConsoleArg).join(' ');
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}… (${joined.length - maxChars} more chars)`;
}

const CAPTURED_LEVELS: ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug'];

interface CaptureState {
  consoleBuffer: RingBuffer<ConsoleEntry>;
  errorBuffer: RingBuffer<ErrorEntry>;
  uninstall: () => void;
}

let state: CaptureState | null = null;

interface ConsoleLike {
  log?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

interface CaptureTargets {
  consoleRef?: ConsoleLike;
  windowRef?: {
    addEventListener: (type: string, handler: (event: never) => void) => void;
    removeEventListener: (type: string, handler: (event: never) => void) => void;
  };
  now?: () => number;
}

/**
 * Patch `console` + global error events into bounded ring buffers.
 *
 * Idempotent: calling it twice does not double-wrap (which would double every
 * log line and, worse, leave an un-restorable console after uninstall).
 * Returns the uninstall function; the buffers survive uninstall so a report can
 * still be filed after teardown.
 */
export function installDiagnosticsCapture(targets: CaptureTargets = {}): () => void {
  if (state) return state.uninstall;

  const consoleRef = targets.consoleRef ?? (typeof console !== 'undefined' ? (console as ConsoleLike) : undefined);
  const windowRef = targets.windowRef ?? (typeof window !== 'undefined' ? (window as unknown as CaptureTargets['windowRef']) : undefined);
  const now = targets.now ?? (() => Date.now());

  const consoleBuffer = createRingBuffer<ConsoleEntry>(CONSOLE_BUFFER_SIZE);
  const errorBuffer = createRingBuffer<ErrorEntry>(ERROR_BUFFER_SIZE);

  const originals = new Map<ConsoleLevel, (...args: unknown[]) => void>();

  if (consoleRef) {
    for (const level of CAPTURED_LEVELS) {
      const original = consoleRef[level];
      if (typeof original !== 'function') continue;
      originals.set(level, original);
      consoleRef[level] = (...args: unknown[]) => {
        // Capture must never be the reason a log call fails.
        try {
          consoleBuffer.push({ level, message: formatConsoleArgs(args), at: now() });
        } catch {
          /* ignore */
        }
        original.apply(consoleRef, args);
      };
    }
  }

  const onError = (event: { message?: string; filename?: string; lineno?: number; colno?: number; error?: unknown }) => {
    try {
      const where = event?.filename ? `${event.filename}:${event.lineno ?? 0}:${event.colno ?? 0}` : '';
      const detail = event?.error instanceof Error && event.error.stack ? `\n${event.error.stack}` : '';
      errorBuffer.push({
        kind: 'error',
        message: `${event?.message || 'Unknown error'}${detail}`,
        source: where,
        at: now(),
      });
    } catch {
      /* ignore */
    }
  };

  const onRejection = (event: { reason?: unknown }) => {
    try {
      errorBuffer.push({
        kind: 'unhandledrejection',
        message: formatConsoleArg(event?.reason),
        source: '',
        at: now(),
      });
    } catch {
      /* ignore */
    }
  };

  windowRef?.addEventListener('error', onError as never);
  windowRef?.addEventListener('unhandledrejection', onRejection as never);

  const uninstall = () => {
    if (consoleRef) {
      for (const [level, original] of originals) consoleRef[level] = original;
    }
    windowRef?.removeEventListener('error', onError as never);
    windowRef?.removeEventListener('unhandledrejection', onRejection as never);
    state = null;
  };

  state = { consoleBuffer, errorBuffer, uninstall };
  return uninstall;
}

/** Test/teardown hook: restore console and drop the buffers. */
export function resetDiagnosticsCapture() {
  state?.uninstall();
  state = null;
}

export interface SnapshotEnvironment {
  buildId: string;
  userAgent: string;
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  language: string;
  capturedAt: string;
}

/**
 * Build the attachable snapshot from raw buffers. Pure — the environment is
 * passed in, so this is testable without a browser and the caller decides what
 * counts as "the environment".
 *
 * Every captured string is run through redactSecrets HERE (not at capture time)
 * so the in-memory buffer stays faithful for debugging while nothing leaves
 * the page unscrubbed.
 */
export function buildDiagnosticsSnapshot(
  env: SnapshotEnvironment,
  consoleEntries: ConsoleEntry[],
  errorEntries: ErrorEntry[],
  truncated = false,
): DiagnosticsSnapshot {
  return {
    buildId: env.buildId,
    userAgent: redactSecrets(env.userAgent),
    url: redactSecrets(env.url),
    viewport: { width: Math.round(env.viewportWidth), height: Math.round(env.viewportHeight) },
    language: env.language,
    capturedAt: env.capturedAt,
    console: consoleEntries.map(entry => ({ ...entry, message: redactSecrets(entry.message) })),
    errors: errorEntries.map(entry => ({
      ...entry,
      message: redactSecrets(entry.message),
      source: redactSecrets(entry.source),
    })),
    truncated,
  };
}

/** Current buffer contents, oldest first. Empty when capture was never installed. */
export function getCapturedConsole(): ConsoleEntry[] {
  return state ? state.consoleBuffer.toArray() : [];
}

export function getCapturedErrors(): ErrorEntry[] {
  return state ? state.errorBuffer.toArray() : [];
}

/** True when the console ring buffer has wrapped and older lines were dropped. */
export function consoleCaptureTruncated(): boolean {
  return state ? state.consoleBuffer.pushed > state.consoleBuffer.size : false;
}
