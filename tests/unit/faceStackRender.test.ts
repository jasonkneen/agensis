import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FaceStack } from '../../src/components/chat/FaceStack';
import { ReactionBar } from '../../src/components/chat/ReactionBar';
import { SeenPill, QueuedPill } from '../../src/components/chat/SeenPill';
import { TooltipProvider } from '../../src/components/ui/tooltip';
import { buildReaderFaces } from '../../src/lib/readerFaces';
import type { WorkspaceAgent } from '../../src/types';

// What the pure tests cannot settle: these MOUNT, the chips show faces rather
// than counts, and the settled shape holds — 👀 is a chip in the reaction row,
// there is no eye component left, and nothing renders for "not seen yet".
//
// `createElement` inside a `.ts` file rather than JSX, because the runner's glob
// is tests/unit/**/*.test.ts and `.test.tsx` is not in it. Same harness as
// tests/unit/reactionBarRender.test.ts — do not invent a second one.

const ME = 'me-1';

const agent = (over: Partial<WorkspaceAgent>): WorkspaceAgent => ({
  id: 'a1', workspace_id: 'w1', name: 'Coder', avatar: '', description: '', system_prompt: '', ...over,
} as WorkspaceAgent);

const resolveFace = buildReaderFaces({
  members: [{ user_id: ME, email: 'jason@example.com' }],
  agents: [
    agent({ id: 'a1', name: 'Coder', accent_color: '#38bdf8' }),
    agent({ id: 'a2', name: 'Grok' }),
    agent({ id: 'a3', name: 'Hermes' }),
    agent({ id: 'a4', name: 'Amp' }),
  ],
});
const resolveName = (id: string) => resolveFace(id).name;

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

const faces = () => Array.from(container.querySelectorAll('[data-reader-face]'));

describe('FaceStack', () => {
  it('draws one face per reader', () => {
    render(createElement(FaceStack, { readerIds: ['a1', 'a2'], resolveFace }));
    expect(faces()).toHaveLength(2);
  });

  it('caps at three and says how many are hidden', () => {
    render(createElement(FaceStack, { readerIds: ['a1', 'a2', 'a3', 'a4'], resolveFace }));
    expect(faces()).toHaveLength(3);
    expect(container.textContent).toContain('+1');
  });

  it('is hidden from screen readers, because the chip says it in words', () => {
    render(createElement(FaceStack, { readerIds: ['a1'], resolveFace }));
    expect(container.querySelector('[data-face-stack]')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('renders nothing at all for nobody', () => {
    render(createElement(FaceStack, { readerIds: [], resolveFace }));
    expect(container.querySelector('[data-face-stack]')).toBeNull();
  });

  it('never puts a raw uuid in the markup, not even as a test hook', () => {
    // Same rule the reaction row already holds itself to: a uuid lands in any
    // screenshot of the DOM and tells the reader nothing.
    const uuid = '3f7c1a52-0000-4000-8000-000000000000';
    render(createElement(FaceStack, { readerIds: [uuid], resolveFace }));
    expect(container.innerHTML).not.toContain('3f7c1a52');
    expect(container.querySelector('[data-reader-face="unknown"]')).not.toBeNull();
  });
});

describe('SeenPill', () => {
  it('is the 👀 chip, and it is not a button', () => {
    // SETTLED (src/lib/seenPill.ts): 👀 in the reaction row is the only read
    // indicator, and it is an assertion, not a toggle. You cannot un-see a
    // message on somebody else's behalf.
    render(createElement(SeenPill, { readerIds: ['a1'], resolveName, resolveFace }));
    const chip = container.querySelector('[data-seen-pill]');
    expect(chip).not.toBeNull();
    expect(chip?.tagName).toBe('SPAN');
    expect(container.textContent).toContain('👀');
  });

  it('shows faces instead of a count', () => {
    // "2" does not tell you whether the agent you asked has read it.
    render(createElement(SeenPill, { readerIds: ['a1', 'a2'], resolveName, resolveFace }));
    expect(faces()).toHaveLength(2);
    expect(container.textContent).not.toContain('2');
  });

  it('falls back to a count with no face lookup', () => {
    render(createElement(SeenPill, { readerIds: ['a1', 'a2'], resolveName }));
    expect(faces()).toHaveLength(0);
    expect(container.textContent).toContain('2');
  });

  it('renders nothing until somebody has read it', () => {
    // The trade the chip makes: it cannot render absence. There is no hollow
    // eye and no "Sent" chip — that was tried and cut.
    render(createElement(SeenPill, { readerIds: [], resolveName, resolveFace }));
    expect(container.querySelector('[data-seen-pill]')).toBeNull();
  });

  it('names the readers in the accessible label, never a uuid', () => {
    const uuid = '3f7c1a52-0000-4000-8000-000000000000';
    render(createElement(SeenPill, { readerIds: ['a1', uuid], resolveName, resolveFace }));
    const label = container.querySelector('[data-seen-pill]')?.getAttribute('aria-label') || '';
    expect(label).toContain('Coder');
    expect(label).not.toContain('3f7c1a52');
  });
});

describe('QueuedPill', () => {
  const queued = { queued: true, workers: 1, agentIds: ['a1'] };

  it('shows whose turn it is waiting behind', () => {
    render(createElement(QueuedPill, { state: queued, resolveFace }));
    expect(container.querySelector('[data-queued-pill]')).not.toBeNull();
    expect(faces()).toHaveLength(1);
    expect(container.textContent).toContain('Queued');
  });

  it('still renders the word alone with no face lookup', () => {
    render(createElement(QueuedPill, { state: queued }));
    expect(container.textContent).toContain('Queued');
    expect(faces()).toHaveLength(0);
  });

  it('renders nothing when the message is not queued', () => {
    render(createElement(QueuedPill, { state: { queued: false, workers: 0, agentIds: [] }, resolveFace }));
    expect(container.querySelector('[data-queued-pill]')).toBeNull();
  });
});

describe('the reaction row', () => {
  const props = {
    currentUserId: ME,
    resolveName,
    onToggle: () => {},
    reactionUses: [],
  };

  it('shows who acknowledged, not how many did', () => {
    // 👍 means acknowledged and it is a REAL reaction an agent adds via
    // react_to_message — so the question is which agent, not how many.
    render(createElement(ReactionBar, { ...props, reactions: { '👍': ['a1'] }, resolveFace }));
    expect(faces()).toHaveLength(1);
    expect(container.querySelector('[data-reader-face="Coder"]')).not.toBeNull();
  });

  it('keeps the numeral when no face lookup is given', () => {
    render(createElement(ReactionBar, { ...props, reactions: { '👍': ['a1', 'a2'] } }));
    expect(container.textContent).toContain('2');
    expect(faces()).toHaveLength(0);
  });

  it('keeps aria-pressed on the pills, which faces must not replace', () => {
    render(createElement(ReactionBar, { ...props, reactions: { '👍': [ME] }, resolveFace }));
    expect(container.querySelector('button[aria-pressed="true"]')).not.toBeNull();
  });

  it('puts the derived chips ahead of the reactions so they never jump sideways', () => {
    render(createElement(ReactionBar, {
      ...props,
      reactions: { '👍': ['a1'] },
      resolveFace,
      leadingSlot: createElement(SeenPill, { readerIds: ['a2'], resolveName, resolveFace }),
    }));
    const html = container.innerHTML;
    expect(html.indexOf('data-seen-pill')).toBeGreaterThan(-1);
    expect(html.indexOf('data-seen-pill')).toBeLessThan(html.indexOf('👍'));
  });
});
