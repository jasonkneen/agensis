import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROWSER_ZOOM_STEPS, MAX_BROWSER_ZOOM, MIN_BROWSER_ZOOM } from '@/lib/zoom';

// The app-level fallback zoom runs in the MAIN process, which cannot import the
// ESM module the renderer uses (CommonJS, different build), so the ladder is
// duplicated there as APP_ZOOM_STEPS. Duplication drifts silently: the two would
// disagree only when someone zooms an unrelated window, which nobody tests by
// hand. This test reads the real source and pins them together.

const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'electron/main.cjs'), 'utf8');

/** The numeric literal array assigned to APP_ZOOM_STEPS in main.cjs. */
function mainProcessLadder(): number[] {
  const match = /const APP_ZOOM_STEPS = \[([^\]]+)\]/.exec(mainSource);
  expect(match, 'APP_ZOOM_STEPS must still exist in electron/main.cjs').toBeTruthy();
  return (match![1].match(/-?\d*\.?\d+/g) ?? []).map(Number);
}

describe('the app-zoom ladder', () => {
  it('is identical in the shell and in src/lib/zoom.ts', () => {
    expect(mainProcessLadder()).toEqual([...BROWSER_ZOOM_STEPS]);
  });

  it('covers the same bounds the renderer clamps to', () => {
    const ladder = mainProcessLadder();
    expect(ladder[0]).toBe(MIN_BROWSER_ZOOM);
    expect(ladder[ladder.length - 1]).toBe(MAX_BROWSER_ZOOM);
  });

  it('stops claiming Cmd+= at the ends, so the app fallback stays reachable', () => {
    // The shell's zoomStep must clamp rather than wrap: a wrap would turn a
    // repeated Cmd+= into a jarring jump back to 25%.
    expect(mainSource).toMatch(/Math\.min\(5, Math\.max\(0\.25,/);
  });
});
