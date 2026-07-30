import { describe, expect, it } from 'vitest';
import {
  MIN_MESSAGE_COLUMN_PX,
  resolvePanelPx,
  shouldOverlaySidePanel,
} from '../../src/components/chat/sidePanelLayout';

const base = {
  shellWidth: 1200,
  sidePanel: 'sub-threads' as const,
  panelWidth: 360,
  threadPanelWidth: null,
};

describe('resolvePanelPx', () => {
  it('uses the stored width for every panel but the thread', () => {
    expect(resolvePanelPx({ ...base, panelWidth: 420 })).toBe(420);
  });

  it('resolves a never-dragged thread panel from its 45% default', () => {
    // The style is literally `width: '45%'` until someone drags it, so the px
    // it would occupy has to be derived from the shell rather than read.
    expect(resolvePanelPx({ ...base, sidePanel: 'thread', shellWidth: 1000 })).toBe(450);
    expect(resolvePanelPx({ ...base, sidePanel: 'thread', threadPanelWidth: 500 })).toBe(500);
  });
});

describe('shouldOverlaySidePanel', () => {
  it('splits when the messages keep a readable column', () => {
    expect(shouldOverlaySidePanel(base)).toBe(false);
  });

  it('takes the whole shell when the messages would be crushed', () => {
    // The reported case: a chat floating on the agents view, panel open, text
    // wrapping to two or three words a line.
    expect(shouldOverlaySidePanel({ ...base, shellWidth: 600 })).toBe(true);
  });

  it('is decided by the message column, not by a viewport breakpoint', () => {
    // A roomy window whose panel has been dragged too wide is the same failure
    // and gets the same answer — which a fixed breakpoint on window width would
    // miss entirely.
    expect(shouldOverlaySidePanel({ ...base, shellWidth: 1200, panelWidth: 1000 })).toBe(true);
    // ...and a narrow-ish shell with a slim panel is still fine to split.
    expect(shouldOverlaySidePanel({ ...base, shellWidth: 700, panelWidth: 280 })).toBe(false);
  });

  it('switches exactly at the readable minimum', () => {
    const shellWidth = base.panelWidth + MIN_MESSAGE_COLUMN_PX;
    expect(shouldOverlaySidePanel({ ...base, shellWidth })).toBe(false);
    expect(shouldOverlaySidePanel({ ...base, shellWidth: shellWidth - 1 })).toBe(true);
  });

  it('never overlays with no panel open, or before the shell is measured', () => {
    expect(shouldOverlaySidePanel({ ...base, sidePanel: null, shellWidth: 200 })).toBe(false);
    // Overlaying on an unmeasured shell would render a full-width panel on the
    // first paint and snap it back to a split one frame later.
    expect(shouldOverlaySidePanel({ ...base, shellWidth: 0 })).toBe(false);
  });

  it('applies to the thread panel too, including its percentage default', () => {
    // 45% of 600 is 270, leaving 330 — still readable.
    expect(shouldOverlaySidePanel({ ...base, sidePanel: 'thread', shellWidth: 600 })).toBe(false);
    // 45% of 560 is 252, leaving 308 — not.
    expect(shouldOverlaySidePanel({ ...base, sidePanel: 'thread', shellWidth: 560 })).toBe(true);
  });
});
