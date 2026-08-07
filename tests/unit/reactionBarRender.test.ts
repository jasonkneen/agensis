import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ReactionBar } from '../../src/components/chat/ReactionBar';
import { TooltipProvider } from '../../src/components/ui/tooltip';

// The claims a pure test cannot settle: these components MOUNT, and what they
// put in the accessibility tree is what a screen reader needs.
//
// Green logic tests are not the gate in this repo — the record is that a
// persisted filter once hid its own control and looked like data loss while
// every test passed. This is the cheapest available stand-in for looking at it:
// it catches a component that throws on render, and it asserts the two things
// review keeps having to re-check by eye (aria-pressed on a toggle, and no raw
// uuid in a tooltip).
//
// `createElement` inside a `.ts` file rather than JSX, because the runner's glob
// is tests/unit/**/*.test.ts and `.test.tsx` is not in it. Same opening as
// tests/unit/presenceRoster.test.ts — do not invent a second harness.

const ME = 'me-1';
const THEM = 'them-1';

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
  // Every Tooltip in the app sits under one provider in App.tsx; a component
  // that needed its own would be a bug at the real call site too.
  act(() => root.render(createElement(TooltipProvider, null, node)));
}

describe('ReactionBar', () => {
  const props = {
    currentUserId: ME,
    resolveName: (id: string) => (id === THEM ? 'Ana' : null),
    onToggle: () => {},
  };

  it('renders nothing at all when there are no reactions', () => {
    // No reserved space and no layout shift on a message nobody has reacted to,
    // which is almost every message.
    render(createElement(ReactionBar, { ...props, reactions: {} }));
    expect(container.textContent).toBe('');
    expect(container.querySelectorAll('button')).toHaveLength(0);
  });

  it('renders a pill with the glyph and the count, and an opener', () => {
    render(createElement(ReactionBar, { ...props, reactions: { '👍': [THEM, ME] } }));
    const pill = container.querySelector('[aria-pressed]');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toContain('👍');
    // The numeral is always drawn, including at 1 — never "+1", never hidden.
    expect(pill?.textContent).toContain('2');
    expect(container.querySelector('[aria-label="Add a reaction"]')).not.toBeNull();
  });

  it('carries aria-pressed, the only signal a screen reader has that this toggles', () => {
    render(createElement(ReactionBar, { ...props, reactions: { '👍': [ME], '🎉': [THEM] } }));
    const pressed = [...container.querySelectorAll('[aria-pressed]')]
      .map(node => [node.getAttribute('aria-label'), node.getAttribute('aria-pressed')]);
    expect(pressed).toContainEqual(['👍, 1 reaction, you reacted', 'true']);
    expect(pressed).toContainEqual(['🎉, 1 reaction', 'false']);
  });

  it('never puts a raw uuid on screen for an unresolvable reactor', () => {
    const uuid = '3f7c1a52-0000-4000-8000-000000000000';
    render(createElement(ReactionBar, { ...props, reactions: { '👍': [uuid] } }));
    expect(container.innerHTML).not.toContain('3f7c1a52');
  });
});

