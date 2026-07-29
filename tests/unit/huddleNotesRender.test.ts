import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

// The Notes tab. Two things worth pinning:
//   1. it actually mounts and shows an editable box once a huddle exists —
//      the same "does the import graph hold" gate every other huddle surface
//      has, because a blank tab and a green typecheck look identical;
//   2. typing debounces into ONE save rather than one per keystroke, and a
//      blur flushes immediately rather than losing the last few characters —
//      the two behaviours a screenshot cannot show.

const stub = vi.hoisted(() => ({
  record: { state: null as unknown, notes: '', loading: false, savingNotes: false, saveNotes: vi.fn(async () => true) },
}));

vi.mock('@/hooks/useHuddle', () => ({
  useHuddleRecord: () => stub.record,
}));

let HuddleNotes: typeof import('../../src/components/huddle/HuddleNotes')['HuddleNotes'];
let HuddleSessionContext: typeof import('../../src/components/huddle/HuddleSessionContext')['HuddleSessionContext'];

let container: HTMLDivElement;
let root: Root;

beforeAll(async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  ({ HuddleNotes } = await import('../../src/components/huddle/HuddleNotes'));
  ({ HuddleSessionContext } = await import('../../src/components/huddle/HuddleSessionContext'));
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  stub.record = { state: null, notes: '', loading: false, savingNotes: false, saveNotes: vi.fn(async () => true) };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

// React's onChange is wired to the native `input` event and reads the value
// off the node, so the value has to be set through the prototype setter React
// patched — plain `box.value = x` updates React's own value tracker too, and
// the input event that follows then looks like a no-op change.
function setTextareaValue(box: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(box, value);
  box.dispatchEvent(new Event('input', { bubbles: true }));
}

function fakeSession(overrides: Record<string, unknown> = {}) {
  return {
    huddle: { id: 'h1' },
    notes: '',
    saveNotes: vi.fn(async () => true),
    ...overrides,
  } as unknown as import('../../src/components/huddle/HuddleSessionContext').HuddleSession;
}

describe('HuddleNotes', () => {
  it('says notes appear once a huddle starts when there is nothing to write into', () => {
    act(() => {
      root.render(createElement(HuddleNotes, { workspaceId: 'ws1', huddleId: null }));
    });
    expect(container.querySelector('[data-testid="huddle-notes-textarea"]')).toBeNull();
    expect(container.textContent).toContain('once this huddle has started');
  });

  it('renders an editable box for the live huddle, seeded from the session', () => {
    const session = fakeSession({ notes: 'agenda: ship it' });
    act(() => {
      root.render(
        createElement(
          HuddleSessionContext.Provider,
          { value: session },
          createElement(HuddleNotes, { workspaceId: 'ws1', huddleId: null }),
        ),
      );
    });
    const box = container.querySelector('[data-testid="huddle-notes-textarea"]') as HTMLTextAreaElement | null;
    expect(box).not.toBeNull();
    expect(box?.value).toBe('agenda: ship it');
  });

  it('debounces keystrokes into one save, and flushes on blur', () => {
    vi.useFakeTimers();
    const session = fakeSession();
    act(() => {
      root.render(
        createElement(
          HuddleSessionContext.Provider,
          { value: session },
          createElement(HuddleNotes, { workspaceId: 'ws1', huddleId: null }),
        ),
      );
    });
    const box = container.querySelector('[data-testid="huddle-notes-textarea"]') as HTMLTextAreaElement;

    act(() => {
      setTextareaValue(box, 'B');
      setTextareaValue(box, 'Br');
      setTextareaValue(box, 'Bring the deck');
    });
    expect(session.saveNotes).not.toHaveBeenCalled();

    act(() => { vi.advanceTimersByTime(600); });
    expect(session.saveNotes).toHaveBeenCalledTimes(1);
    expect(session.saveNotes).toHaveBeenCalledWith('Bring the deck');

    // A second edit followed by a blur before the debounce fires must not be
    // dropped on the floor.
    act(() => { setTextareaValue(box, 'Bring the deck and the cables'); });
    // React implements onBlur on top of the native, bubbling 'focusout' event
    // rather than 'blur' (which does not bubble) — this is what a real Tab-away
    // or click-elsewhere dispatches under the hood.
    act(() => { box.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(session.saveNotes).toHaveBeenCalledTimes(2);
    expect(session.saveNotes).toHaveBeenLastCalledWith('Bring the deck and the cables');
  });

  it('reads and writes a past huddle via useHuddleRecord when it differs from the live one', () => {
    stub.record = { state: null, notes: 'old note', loading: false, savingNotes: false, saveNotes: vi.fn(async () => true) };
    act(() => {
      root.render(createElement(HuddleNotes, { workspaceId: 'ws1', huddleId: 'h-old' }));
    });
    const box = container.querySelector('[data-testid="huddle-notes-textarea"]') as HTMLTextAreaElement | null;
    expect(box?.value).toBe('old note');
  });
});
