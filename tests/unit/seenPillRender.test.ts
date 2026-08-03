import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactionBar } from '../../src/components/chat/ReactionBar';
import { QueuedPill, SeenPill, UnseenPill } from '../../src/components/chat/SeenPill';
import { TooltipProvider } from '../../src/components/ui/tooltip';

// The claims a pure test cannot settle: this component MOUNTS, and the thing it
// must never become is a button.
//
// `createElement` inside a `.ts` file rather than JSX, because the runner's glob
// is tests/unit/**/*.test.ts and `.test.tsx` is not in it. Same harness as
// tests/unit/reactionBarRender.test.ts — do not invent a second one.

const ME = 'me-1';
const AGENT = 'agent-1';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(node: React.ReactNode) {
  act(() => root.render(createElement(TooltipProvider, null, node)));
}

const resolve = (id: string) => (id === AGENT ? 'Coder' : null);

describe('SeenPill', () => {
  it('renders nothing when nobody has read it', () => {
    // "0 people have seen this" is a sentence no product should say out loud,
    // and an empty chip under every message you send is furniture.
    render(createElement(SeenPill, { readerIds: [], resolveName: resolve }));
    expect(container.textContent).toBe('');
  });

  it('is NOT a control — seen is an assertion, not a toggle', () => {
    render(createElement(SeenPill, { readerIds: [AGENT], resolveName: resolve }));
    expect(container.querySelectorAll('button')).toHaveLength(0);
    expect(container.querySelector('[aria-pressed]')).toBeNull();
    expect(container.querySelector('[data-seen-pill]')).not.toBeNull();
  });

  it('states the count in words, because 👀 announces as "eyes"', () => {
    render(createElement(SeenPill, { readerIds: [AGENT], resolveName: resolve }));
    const pill = container.querySelector('[data-seen-pill]');
    expect(pill?.getAttribute('aria-label')).toBe('Seen by 1 reader: Coder');
    // …and the numeral is on screen, so nobody has to hover to learn it.
    expect(pill?.textContent).toContain('1');
  });

  it('never puts a raw uuid in the accessible name', () => {
    const uuid = '3f8b0c22-0000-4000-8000-000000000000';
    render(createElement(SeenPill, { readerIds: [uuid], resolveName: resolve }));
    const label = container.querySelector('[data-seen-pill]')?.getAttribute('aria-label') ?? '';
    expect(label).toContain('Someone');
    expect(label).not.toContain('3f8b');
  });
});

describe('UnseenPill', () => {
  it('says "sent, not seen yet" — the state a pill cannot show by being absent', () => {
    render(createElement(UnseenPill, {}));
    const pill = container.querySelector('[data-unseen-pill]');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute('aria-label')).toBe('Sent, not seen yet');
  });

  it('is not a control either — nothing here is clickable', () => {
    render(createElement(UnseenPill, {}));
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('QueuedPill', () => {
  it('renders nothing when the message is not queued', () => {
    render(createElement(QueuedPill, { state: { queued: false, workers: 0 } }));
    expect(container.textContent).toBe('');
  });

  it('explains the wait and stays a non-control', () => {
    render(createElement(QueuedPill, { state: { queued: true, workers: 1 } }));
    const pill = container.querySelector('[data-queued-pill]');
    expect(pill?.textContent).toContain('Queued');
    expect(pill?.getAttribute('aria-label'))
      .toBe('Sent while the agent was already working — this is next in line');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('ReactionBar leadingSlot', () => {
  const props = {
    currentUserId: ME,
    resolveName: resolve,
    onToggle: () => {},
  };

  it('renders for a derived chip alone, WITHOUT the add-reaction opener', () => {
    // The opener under every message anyone has read is exactly the furniture
    // the hover rail exists to avoid.
    render(createElement(ReactionBar, {
      ...props,
      reactions: {},
      leadingSlot: createElement(SeenPill, { readerIds: [AGENT], resolveName: resolve }),
    }));
    expect(container.querySelector('[data-seen-pill]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Add a reaction"]')).toBeNull();
  });

  it('still renders nothing when there is neither a reaction nor a chip', () => {
    render(createElement(ReactionBar, { ...props, reactions: {}, leadingSlot: null }));
    expect(container.textContent).toBe('');
  });

  it('puts the derived chip FIRST so it does not jump when somebody reacts', () => {
    render(createElement(ReactionBar, {
      ...props,
      reactions: { '\u{1F44D}': [AGENT] },
      leadingSlot: createElement(SeenPill, { readerIds: [AGENT], resolveName: resolve }),
    }));
    const row = container.querySelector('[data-seen-pill]')?.parentElement;
    expect(row?.firstElementChild?.hasAttribute('data-seen-pill')).toBe(true);
    // A real reaction is still a toggle next to it, and the opener is back.
    expect(container.querySelector('[aria-pressed]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Add a reaction"]')).not.toBeNull();
  });
});
