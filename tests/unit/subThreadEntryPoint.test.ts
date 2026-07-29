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

// Delegate now lives in the message's floating action bar, not under the
// message. The gap this replaced: the button was hover-revealed with
// `opacity-0`, which keeps an element in layout, and its wrapper rendered on
// EVERY message — so every message carried an invisible ~28px row beneath it.
// Moving into an existing icon bar costs no layout at all, and works on touch
// (where hover never fires) without needing a pointer-coarse escape hatch.
describe('Delegate lives in the message action bar', () => {
  const chat = () => read('src/components/windows/ChatWindowContent.tsx');

  it('is an icon button in the floating bar, beside the thread action', () => {
    const c = chat();
    const bar = c.slice(c.indexOf("aria-label={replyCount ? 'Open thread' : 'Start thread'}"), c.indexOf("{onTogglePin && ("));
    expect(bar, 'Delegate belongs in the same bar as Open thread / Pin').toContain('onCreateSubThread');
    expect(bar).toMatch(/aria-label="Delegate to an agent"/);
  });

  it('is called Delegate, not Sub-thread', () => {
    const c = chat();
    const bar = c.slice(c.indexOf("aria-label={replyCount ? 'Open thread' : 'Start thread'}"), c.indexOf("{onTogglePin && ("));
    expect(bar).not.toMatch(/>\s*Sub-thread\s*</);
  });

  it('costs no layout: no hover-revealed button remains under the message', () => {
    const c = chat();
    // The old shape — a labelled button revealed by group-hover — is gone.
    expect(c).not.toMatch(/group-hover:inline-flex[^"]*"\s*\n\s*onClick=\{onCreateSubThread\}/);
    expect(c, 'opacity-0 on a delegate button is the gap bug').not.toMatch(/opacity-0[^"]*"\s*\n?\s*onClick=\{onCreateSubThread\}/);
  });

  it('the stats row renders only when it has real content to show', () => {
    const c = chat();
    const guard = c.slice(c.indexOf('{(replyCount && onOpenThread)'), c.indexOf('{(replyCount && onOpenThread)') + 160);
    // `|| onCreateSubThread` is always truthy, so keeping it would render an
    // empty row under every message — the gap, reintroduced.
    expect(guard, 'the row must not be gated on an always-true prop').not.toContain('onCreateSubThread');
  });
});
