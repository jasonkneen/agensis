import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FeedbackButton } from '../../src/components/feedback/FeedbackButton';
import { DEFAULT_FEEDBACK_ANCHOR } from '../../src/lib/feedbackAnchor';

// The launcher's drag is plumbing, and plumbing is where this breaks silently:
//
//   1. the ref has to reach the real <button> through the Button primitive, or
//      every imperative paint is a no-op and the control simply never moves;
//   2. jsdom has no setPointerCapture at all — the same shape as the Chromium
//      NotFoundError this guards — so an unguarded call would abort the gesture
//      before any drag state exists and leave the button inert;
//   3. a drag must not also be a click, and a click must not be eaten by the
//      drag. Getting either wrong makes the one control a stuck user needs
//      either unmovable or unopenable, and both typecheck perfectly.

const KEY = 'agensis.feedback.anchor:user-1';

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function mount(userId: string | null = 'user-1') {
  act(() => {
    root.render(createElement(FeedbackButton, { workspaceId: 'ws-1', userId, contextLabel: 'Main' }));
  });
  const button = container.querySelector<HTMLButtonElement>('button[data-feedback-ui]');
  if (!button) throw new Error('feedback launcher did not render');
  return button;
}

/** jsdom has no PointerEvent; React reads these fields off whatever is dispatched. */
function pointer(type: string, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  return event;
}

function drag(button: HTMLButtonElement, from: [number, number], to: [number, number]) {
  act(() => {
    button.dispatchEvent(pointer('pointerdown', from[0], from[1]));
    button.dispatchEvent(pointer('pointermove', to[0], to[1]));
    button.dispatchEvent(pointer('pointerup', to[0], to[1]));
    button.dispatchEvent(pointer('click', to[0], to[1]));
  });
}

describe('FeedbackButton position', () => {
  it('paints at the default home position with nothing stored', () => {
    const button = mount();
    expect(button.style.right).toBe(`${DEFAULT_FEEDBACK_ANCHOR.right}px`);
    expect(button.style.bottom).toBe(`${DEFAULT_FEEDBACK_ANCHOR.bottom}px`);
  });

  it('restores a stored position on mount', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ right: 240, bottom: 180 }));
    const button = mount();
    expect(button.style.right).toBe('240px');
    expect(button.style.bottom).toBe('180px');
  });

  it('moves on a drag and persists where it was dropped', () => {
    const button = mount();
    // 60px left and 100px up: insets from the bottom-right corner GROW.
    drag(button, [900, 800], [840, 700]);

    expect(button.style.right).toBe(`${DEFAULT_FEEDBACK_ANCHOR.right + 60}px`);
    expect(button.style.bottom).toBe(`${DEFAULT_FEEDBACK_ANCHOR.bottom + 100}px`);
    expect(JSON.parse(window.localStorage.getItem(KEY) || 'null')).toEqual({
      right: DEFAULT_FEEDBACK_ANCHOR.right + 60,
      bottom: DEFAULT_FEEDBACK_ANCHOR.bottom + 100,
    });
  });

  it('does not open the dialog on the click that ends a drag', () => {
    const button = mount();
    drag(button, [900, 800], [840, 700]);
    expect(container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
  });

  it('still opens on a press that never travelled', () => {
    const button = mount();
    act(() => {
      button.dispatchEvent(pointer('pointerdown', 900, 800));
      // Inside DRAG_THRESHOLD_PX — an ordinary mouse wobbles this much.
      button.dispatchEvent(pointer('pointermove', 901, 801));
      button.dispatchEvent(pointer('pointerup', 901, 801));
      button.dispatchEvent(pointer('click', 901, 801));
    });
    expect(button.style.right).toBe(`${DEFAULT_FEEDBACK_ANCHOR.right}px`);
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });

  it('keeps the position in memory only when there is no user to scope it to', () => {
    const button = mount(null);
    drag(button, [900, 800], [840, 700]);
    expect(button.style.right).toBe(`${DEFAULT_FEEDBACK_ANCHOR.right + 60}px`);
    expect(window.localStorage.length).toBe(0);
  });

  it('is keyboard-reachable and named', () => {
    const button = mount();
    expect(button.getAttribute('aria-label')).toBe('Send feedback');
    expect(button.tagName).toBe('BUTTON');
    expect(button.hasAttribute('disabled')).toBe(false);
  });
});
