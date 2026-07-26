import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { HuddleAgentStrip } from '../../src/components/huddle/HuddleAgentStrip';
import type { HuddleAgentOption } from '../../src/lib/huddleAgents';

// The strip is a window-level keyboard owner, which is the dangerous kind. This
// file asserts the two things a reviewer cannot see by reading it:
//   - ⌘/Ctrl+n only reaches it while a huddle is live, and never while someone
//     is typing;
//   - the listener is really gone after unmount and after the huddle drops, so
//     leaving a call cannot leave a keybinding behind.

const AGENTS: HuddleAgentOption[] = [
  { id: 'a1', name: 'Coder', handle: 'coder', avatar: '', accent: '#00a95c' },
  { id: 'a2', name: 'Ada Lovelace', handle: 'ada', avatar: '', accent: '#38bdf8' },
  { id: 'a3', name: 'Code Reviewer', handle: 'code-reviewer', avatar: '', accent: '#a78bfa' },
];

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  act(() => { root = createRoot(container); });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/** The strip with its own selection state, so a switch is observable. */
function Harness({ enabled, agents = AGENTS }: { enabled: boolean; agents?: HuddleAgentOption[] }) {
  const [activeId, setActiveId] = useState(agents[0]?.id || '');
  return createElement(HuddleAgentStrip, { agents, activeId, onSelect: setActiveId, enabled });
}

function render(enabled = true, agents: HuddleAgentOption[] = AGENTS) {
  act(() => { root.render(createElement(Harness, { enabled, agents })); });
}

function chips() {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('[data-active]'));
}

function activeLabel() {
  return chips().find(chip => chip.dataset.active === 'true')?.getAttribute('aria-label') || '';
}

function press(init: KeyboardEventInit, target: EventTarget = window) {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

describe('HuddleAgentStrip', () => {
  it('renders one numbered chip per agent, with the first one active', () => {
    render();
    const rendered = chips();
    expect(rendered).toHaveLength(3);
    // Initials, so a strip of avatar-less agents is still tellable apart, plus
    // the shortcut digit — the binding has to be visible, not hidden in a menu.
    expect(rendered.map(chip => chip.textContent)).toEqual(['CO1', 'AL2', 'CR3']);
    expect(rendered.map(chip => chip.dataset.active)).toEqual(['true', 'false', 'false']);
    expect(rendered[0].getAttribute('aria-pressed')).toBe('true');
    // The handle is on the chip, so "who am I about to talk to" is hoverable.
    expect(rendered[2].getAttribute('title')).toContain('@code-reviewer');
  });

  it('switches on click', () => {
    render();
    act(() => { chips()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); });
    expect(chips().map(chip => chip.dataset.active)).toEqual(['false', 'true', 'false']);
    expect(activeLabel()).toBe('Ada Lovelace is hearing you');
  });

  it('switches on Cmd+n and Ctrl+n, and consumes the keystroke', () => {
    render();
    const meta = press({ key: '3', code: 'Digit3', metaKey: true });
    expect(chips()[2].dataset.active).toBe('true');
    expect(meta.defaultPrevented).toBe(true);

    press({ key: '1', code: 'Digit1', ctrlKey: true });
    expect(chips()[0].dataset.active).toBe('true');
  });

  it('leaves a number with no agent behind it alone', () => {
    render();
    const event = press({ key: '9', code: 'Digit9', metaKey: true });
    expect(chips()[0].dataset.active).toBe('true');
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores the shortcut while the human is typing', () => {
    render();
    const input = document.createElement('input');
    document.body.appendChild(input);
    const event = press({ key: '2', code: 'Digit2', metaKey: true }, input);
    expect(chips()[0].dataset.active).toBe('true');
    expect(event.defaultPrevented).toBe(false);
    input.remove();
  });

  it('does not bind the shortcut when there is no live huddle', () => {
    render(false);
    const event = press({ key: '2', code: 'Digit2', metaKey: true });
    expect(chips()[0].dataset.active).toBe('true');
    expect(event.defaultPrevented).toBe(false);
  });

  it('releases the shortcut when the huddle drops and when it unmounts', () => {
    render(true);
    press({ key: '2', code: 'Digit2', metaKey: true });
    expect(chips()[1].dataset.active).toBe('true');

    // Huddle disconnected: the strip is still on screen but owns no keys.
    render(false);
    expect(press({ key: '3', code: 'Digit3', metaKey: true }).defaultPrevented).toBe(false);
    expect(chips()[1].dataset.active).toBe('true');

    act(() => { root.render(null); });
    expect(press({ key: '1', code: 'Digit1', metaKey: true }).defaultPrevented).toBe(false);
  });

  it('renders nothing at all without agents', () => {
    render(true, []);
    expect(container.querySelector('[data-testid="huddle-agent-strip"]')).toBeNull();
  });
});
