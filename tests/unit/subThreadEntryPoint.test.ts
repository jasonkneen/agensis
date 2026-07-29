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
