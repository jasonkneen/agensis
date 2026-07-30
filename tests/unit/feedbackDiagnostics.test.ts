import { afterEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_BUFFER_SIZE,
  CONSOLE_ENTRY_MAX_CHARS,
  buildDiagnosticsSnapshot,
  consoleCaptureTruncated,
  createRingBuffer,
  formatConsoleArg,
  formatConsoleArgs,
  getCapturedConsole,
  getCapturedErrors,
  installDiagnosticsCapture,
  resetDiagnosticsCapture,
  type ConsoleEntry,
  type ErrorEntry,
} from '../../src/lib/feedbackDiagnostics';

// The console tap runs for the whole life of every session, so the properties
// that matter are the ones that only show up after a long one: bounded memory,
// correct ordering after the buffer wraps, and a clean restore.

afterEach(() => {
  resetDiagnosticsCapture();
});

describe('createRingBuffer', () => {
  it('keeps insertion order before it wraps', () => {
    const buffer = createRingBuffer<number>(5);
    [1, 2, 3].forEach(n => buffer.push(n));
    expect(buffer.toArray()).toEqual([1, 2, 3]);
  });

  it('drops the OLDEST entries once full, and never grows past capacity', () => {
    const buffer = createRingBuffer<number>(3);
    [1, 2, 3, 4, 5].forEach(n => buffer.push(n));
    // This is the whole point: a session that logs forever costs a fixed amount
    // of memory, and what survives is the most RECENT window.
    expect(buffer.toArray()).toEqual([3, 4, 5]);
    expect(buffer.size).toBe(3);
  });

  it('stays correct across several wraps', () => {
    const buffer = createRingBuffer<number>(4);
    for (let n = 0; n < 30; n += 1) buffer.push(n);
    expect(buffer.toArray()).toEqual([26, 27, 28, 29]);
  });

  it('reports total pushes so a caller can tell it truncated', () => {
    const buffer = createRingBuffer<number>(2);
    [1, 2, 3].forEach(n => buffer.push(n));
    expect(buffer.pushed).toBe(3);
    expect(buffer.size).toBe(2);
  });

  it('clamps a nonsense capacity instead of producing a buffer that eats every push', () => {
    const buffer = createRingBuffer<number>(0);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.toArray()).toEqual([2]);
  });
});

describe('formatConsoleArg', () => {
  it('renders primitives and errors readably', () => {
    expect(formatConsoleArg('hi')).toBe('hi');
    expect(formatConsoleArg(null)).toBe('null');
    expect(formatConsoleArg(undefined)).toBe('undefined');
    expect(formatConsoleArg(7)).toBe('7');
    // The stack is the useful half of a logged error.
    expect(formatConsoleArg(new Error('boom'))).toContain('Error: boom');
  });

  it('survives a cyclic object rather than throwing inside a console call', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(formatConsoleArg(cyclic)).toContain('[Circular]');
  });

  it('clamps a huge argument — one streamed agent message can be megabytes', () => {
    const out = formatConsoleArgs(['x'.repeat(5000)]);
    expect(out.length).toBeLessThan(CONSOLE_ENTRY_MAX_CHARS + 60);
    expect(out).toContain('more chars');
  });
});

describe('installDiagnosticsCapture', () => {
  it('captures console output and restores the originals on uninstall', () => {
    const calls: string[] = [];
    const fakeConsole = {
      log: (...args: unknown[]) => { calls.push(`log:${args.join(' ')}`); },
      warn: (...args: unknown[]) => { calls.push(`warn:${args.join(' ')}`); },
    };
    const original = fakeConsole.log;

    const uninstall = installDiagnosticsCapture({ consoleRef: fakeConsole, windowRef: undefined, now: () => 1000 });

    fakeConsole.log('hello', 42);
    fakeConsole.warn('careful');

    // Pass-through is not optional: capture must never swallow a log line.
    expect(calls).toEqual(['log:hello 42', 'warn:careful']);
    expect(getCapturedConsole()).toEqual([
      { level: 'log', message: 'hello 42', at: 1000 },
      { level: 'warn', message: 'careful', at: 1000 },
    ]);

    uninstall();
    expect(fakeConsole.log).toBe(original);
  });

  it('is idempotent — a second install must not double-wrap console', () => {
    const calls: string[] = [];
    const fakeConsole = { log: (...args: unknown[]) => { calls.push(String(args[0])); } };

    installDiagnosticsCapture({ consoleRef: fakeConsole, windowRef: undefined });
    installDiagnosticsCapture({ consoleRef: fakeConsole, windowRef: undefined });
    fakeConsole.log('once');

    // Double-wrapping would log twice AND leave console unrestorable.
    expect(calls).toEqual(['once']);
    expect(getCapturedConsole()).toHaveLength(1);
  });

  it('reports truncation once the ring buffer has wrapped', () => {
    const fakeConsole = { log: () => {} };
    installDiagnosticsCapture({ consoleRef: fakeConsole, windowRef: undefined });
    expect(consoleCaptureTruncated()).toBe(false);
    for (let n = 0; n < CONSOLE_BUFFER_SIZE + 5; n += 1) fakeConsole.log(`line ${n}`);
    expect(consoleCaptureTruncated()).toBe(true);
    expect(getCapturedConsole()).toHaveLength(CONSOLE_BUFFER_SIZE);
  });

  it('returns empty buffers when capture was never installed', () => {
    expect(getCapturedConsole()).toEqual([]);
    expect(getCapturedErrors()).toEqual([]);
  });
});

describe('buildDiagnosticsSnapshot', () => {
  const env = {
    buildId: 'abc123',
    userAgent: 'Mozilla/5.0 (Macintosh)',
    url: 'https://agensis.io/',
    viewportWidth: 1440.4,
    viewportHeight: 900.6,
    language: 'en-GB',
    capturedAt: '2026-07-26T10:00:00.000Z',
  };

  it('redacts every captured string on the way out', () => {
    const token = '3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b.4.1785000000.Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MGFiY2Rl';
    const consoleEntries: ConsoleEntry[] = [{ level: 'log', message: `Bearer ${token}`, at: 1 }];
    const errorEntries: ErrorEntry[] = [{ kind: 'error', message: `failed aga_abcdef123456`, source: 'app.js:1:1', at: 2 }];

    const snapshot = buildDiagnosticsSnapshot(env, consoleEntries, errorEntries);

    // The single assertion this whole feature's safety rests on.
    expect(JSON.stringify(snapshot)).not.toContain('Zm9vYmFy');
    expect(JSON.stringify(snapshot)).not.toContain('aga_abcdef123456');
  });

  it('rounds the viewport and carries build + environment through', () => {
    const snapshot = buildDiagnosticsSnapshot(env, [], []);
    expect(snapshot.viewport).toEqual({ width: 1440, height: 901 });
    expect(snapshot.buildId).toBe('abc123');
    expect(snapshot.language).toBe('en-GB');
    expect(snapshot.truncated).toBe(false);
  });
});
