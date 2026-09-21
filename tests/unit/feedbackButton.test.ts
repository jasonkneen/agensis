import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FeedbackButton, type FeedbackHandle } from '../../src/components/feedback/FeedbackButton';

// The feedback launcher moved into the workspace rail: a fixed, non-movable
// icon that opens the dialog owned by <FeedbackButton> through an imperative
// handle. What matters here is the new contract:
//
//   1. the component renders NO launcher of its own (the rail owns the trigger
//      now), and nothing at all until it is opened;
//   2. calling open() on the ref actually surfaces the dialog — the wire the
//      rail button depends on.

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

function mount(ref: React.RefObject<FeedbackHandle | null>) {
  act(() => {
    root.render(createElement(FeedbackButton, { ref, workspaceId: 'ws-1', userId: 'user-1', contextLabel: 'Main' }));
  });
}

describe('FeedbackButton', () => {
  it('renders no launcher and no dialog of its own until opened', () => {
    const ref = createRef<FeedbackHandle>();
    mount(ref);
    expect(container.querySelector('[data-feedback-ui]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('opens the dialog when the imperative handle fires', () => {
    const ref = createRef<FeedbackHandle>();
    mount(ref);
    act(() => ref.current?.open());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  });
});
