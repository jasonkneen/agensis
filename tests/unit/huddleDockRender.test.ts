import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HuddleDock } from '../../src/components/huddle/HuddleDock';
import { HuddleDockProvider } from '../../src/components/huddle/HuddleDockContext';

// The dock MOUNTS. It pulls in the huddle hook, the panel, the message
// scroller and the composer primitives — a missing provider or a bad import is
// a call panel that never appears, on a completely green typecheck. That is the
// exact failure class this repo shipped tonight: every automated gate passed
// while the screen was wrong.

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('HuddleDock', () => {
  it('mounts inside its provider without throwing', () => {
    act(() => {
      root.render(createElement(HuddleDockProvider, null, createElement(HuddleDock)));
    });
    // No huddle has been opened, so there is nothing to show — but getting
    // here at all proves the import graph and the provider wiring hold.
    expect(container.querySelector('[data-huddle-dock]')).toBeNull();
  });

  it('renders nothing at all outside the provider rather than throwing', () => {
    // A read-only or embedded surface that never opted in simply has no huddle
    // UI — the same contract the channel-scoped context had.
    act(() => { root.render(createElement(HuddleDock)); });
    expect(container.textContent).toBe('');
  });
});
