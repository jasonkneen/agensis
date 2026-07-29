import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Sub-thread CREATION died on 2026-07-25 in d30e6ad, "Remove redundant
// '+ Sub-thread' button from message rows". It removed the button, its picker
// dialog, and what the message called "the now-dead onCreateSubThread prop
// chain" — but the chain wasn't dead, it was the feature's only entry point.
// The hook kept exporting createSubThread with zero callers, so the 12 existing
// sub-threads still opened and replied and nothing could ever make a 13th. It
// looked like sub-threads had silently stopped working for four days.
//
// This guards the CHAIN, not the styling: the button may move or be restyled,
// but createSubThread must keep a caller and the prop must reach the bubble.

const root = join(__dirname, '../..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('sub-thread creation has a live entry point', () => {
  it('useSubThreads still exports createSubThread', () => {
    const hook = read('src/hooks/useSubThreads.ts');
    expect(hook).toContain('const createSubThread');
  });

  it('App.tsx actually calls it — an export with no caller is a dead feature', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('createSubThread,');
    expect(app, 'createSubThread is exported but never invoked').toMatch(/await createSubThread\(/);
  });

  it('the prop reaches the message bubble that renders the button', () => {
    const app = read('src/App.tsx');
    const chat = read('src/components/windows/ChatWindowContent.tsx');
    // App passes it into the scene, the scene passes it on…
    expect(app).toContain('onCreateSubThread={handleCreateSubThreadFromScene}');
    expect(app).toContain('onCreateSubThread={onCreateSubThreadProp}');
    // …ChatWindowContent accepts it and hands the bubble a click handler…
    expect(chat).toContain('onCreateSubThread');
    expect(chat).toMatch(/onCreateSubThread=\{onCreateSubThread \? \(\) =>/);
    // …and something is actually wired to invoke it.
    expect(chat).toMatch(/onCreateSubThread\(subThreadPickerMessageId, agent/);
  });
});

// The button was hover-revealed with `opacity-0`, which keeps it in layout. Its
// wrapper rendered on EVERY message (onCreateSubThread is always supplied), so
// every message in the timeline carried an invisible ~28px row under it — a
// large gap with nothing in it unless you happened to hover.
//
// The fix puts it on the same line as the reply stats and hides it properly.
// These assert the two properties that matter; they do not pin exact classes.
describe('the hover-only sub-thread button costs no layout when hidden', () => {
  const chat = () => read('src/components/windows/ChatWindowContent.tsx');

  it('is display-hidden, not merely transparent', () => {
    const btn = chat().slice(chat().indexOf('Sub-thread') - 900, chat().indexOf('Sub-thread'));
    expect(btn, 'opacity-0 keeps the button in layout — that is the gap').not.toMatch(/\bopacity-0\b/);
    expect(btn).toMatch(/\bhidden\b/);
    expect(btn, 'must come back on hover').toMatch(/group-hover:inline-flex/);
  });

  it('stays reachable on touch, which never fires hover', () => {
    const btn = chat().slice(chat().indexOf('Sub-thread') - 900, chat().indexOf('Sub-thread'));
    expect(btn).toMatch(/pointer-coarse:inline-flex/);
  });

  it('shares one row with the reply stats instead of stacking a second block', () => {
    const c = chat();
    // The stats button is rendered INSIDE the same flex row as the chips.
    const row = c.slice(c.indexOf('{(replyCount && onOpenThread) ||'), c.indexOf('Sub-thread'));
    expect(row, 'the stats button moved into the shared row').toContain('<ThreadReplySummaryButton');
    expect(row).toContain('flex flex-wrap items-center');
  });

  it('does not double the top margin now that the row owns spacing', () => {
    const c = chat();
    const decl = c.slice(c.indexOf('function ThreadReplySummaryButton'), c.indexOf('function ThreadReplySummaryButton') + 2600);
    expect(decl, 'row provides mt-1; the button must not add its own').not.toMatch(/className="mt-1 -ml-1 inline-flex h-7/);
  });
});
