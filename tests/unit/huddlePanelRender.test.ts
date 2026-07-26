import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HuddleMarkerRow } from '../../src/components/huddle/HuddleMarkerRow';
import { HuddlePanel } from '../../src/components/huddle/HuddlePanel';
import type { Message } from '../../src/types';

// Two things a reader cannot check by eye, both of which have shipped broken in
// this repo before:
//
//   1. the channel marker is ONE quiet line, and its link only exists when
//      there is something to open;
//   2. the panel actually mounts. It pulls in the message scroller, the
//      composer primitives, two hooks and the huddle context — a missing
//      provider or a bad import is a blank right-hand side in production and a
//      completely green typecheck.

const MARKER: Message = {
  id: 'm1',
  session_id: 'channel-1',
  role: 'assistant',
  content: 'You were in a huddle · 12:04 · Ada, Sam',
  message_kind: 'huddle',
  huddle_id: 'h1',
  sender_kind: 'system',
  sender_name: 'Huddle',
  created_at: '2026-07-26T10:12:04.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  // React 19 asks for this; without it every act() logs a warning.
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

describe('HuddleMarkerRow', () => {
  it('renders the server sentence verbatim, on one line', () => {
    act(() => { root.render(createElement(HuddleMarkerRow, { message: MARKER })); });
    const row = container.querySelector('[data-testid="huddle-marker"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('You were in a huddle · 12:04 · Ada, Sam');
  });

  it('offers "Open transcript" only when something can be opened', () => {
    const opened: string[] = [];
    act(() => {
      root.render(createElement(HuddleMarkerRow, { message: MARKER, onOpen: (id) => opened.push(id) }));
    });
    const button = container.querySelector('button');
    expect(button?.textContent).toBe('Open transcript');
    act(() => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(opened).toEqual(['h1']);
  });

  it('is a plain statement when its huddle is gone', () => {
    // A dangling huddle_id must not render a button that does nothing. The
    // sentence is complete on its own — that is why the server writes it whole.
    act(() => {
      root.render(createElement(HuddleMarkerRow, {
        message: { ...MARKER, huddle_id: null },
        onOpen: () => {},
      }));
    });
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('You were in a huddle');
  });

  it('renders no chat bubble chrome — it is a fact, not something anyone said', () => {
    act(() => { root.render(createElement(HuddleMarkerRow, { message: MARKER })); });
    // No avatar, no sender name, no timestamp: the whole change is that a call
    // leaves a line in the channel instead of a conversation.
    expect(container.textContent).not.toContain('Huddle · ');
    expect(container.textContent?.trim()).toBe('You were in a huddle · 12:04 · Ada, Sam');
  });
});

describe('HuddlePanel', () => {
  it('mounts outside a huddle provider and says there is nothing here', () => {
    // useHuddleSession() is null outside the provider by design, and both hooks
    // are inert with a null workspace — so this exercises the real import graph
    // and the real JSX without a network, a socket or a LiveKit room.
    act(() => {
      root.render(createElement(HuddlePanel, { workspaceId: null, onClose: () => {} }));
    });
    expect(container.textContent).toContain('No huddle here yet');
    // The composer must not be offered when there is no live huddle to type into.
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('closes through the caller, not by unmounting itself', () => {
    let closed = 0;
    act(() => {
      root.render(createElement(HuddlePanel, { workspaceId: null, onClose: () => { closed += 1; } }));
    });
    const close = container.querySelector('button[aria-label="Close huddle"]');
    expect(close).not.toBeNull();
    act(() => { close?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(closed).toBe(1);
  });
});
