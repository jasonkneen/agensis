import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { usePersistedPreference } from '../../src/hooks/usePersistedPreference';
import { oneOf, viewPreferenceKey } from '../../src/lib/viewPreferences';

// The pure read/validate/write rules are covered in viewPreferences.test.ts.
// What is left, and what is easy to get wrong, is the ORDER things happen in
// around a React render:
//
//   - the stored choice has to be on screen in the FIRST paint, not after an
//     effect, or the window visibly jumps;
//   - switching workspace has to re-read, and must NOT first write the outgoing
//     workspace's value under the incoming workspace's key;
//   - a value that came straight out of storage must not be written back, so a
//     future change of default still reaches everyone who never chose.

const filter = oneOf(['all', 'mine', 'others'] as const);
type Filter = 'all' | 'mine' | 'others';

let container: HTMLDivElement;
let root: Root;
let renders: Filter[];
let setFilter: (next: Filter) => void;

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  window.localStorage.clear();
  renders = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

function Probe({ workspaceId }: { workspaceId: string | null }) {
  const [value, setValue] = usePersistedPreference(
    viewPreferenceKey('tasks.filter', workspaceId),
    filter,
    'all',
  );
  renders.push(value);
  setFilter = setValue;
  return createElement('span', null, value);
}

function render(workspaceId: string | null) {
  act(() => { root.render(createElement(Probe, { workspaceId })); });
}

describe('usePersistedPreference', () => {
  it('restores on the first render, with no flash of the default', () => {
    window.localStorage.setItem('agensis.tasks.filter:ws-1', 'mine');
    render('ws-1');
    // Not "settles on mine" — the FIRST value the component ever saw is mine.
    expect(renders[0]).toBe('mine');
    expect(container.textContent).toBe('mine');
  });

  it('persists a change so the next mount opens on it', () => {
    render('ws-1');
    expect(renders[0]).toBe('all');
    act(() => setFilter('others'));
    expect(window.localStorage.getItem('agensis.tasks.filter:ws-1')).toBe('others');

    act(() => root.unmount());
    root = createRoot(container);
    renders = [];
    render('ws-1');
    expect(renders[0]).toBe('others');
  });

  it('does not write a default the user never chose', () => {
    render('ws-1');
    expect(window.localStorage.getItem('agensis.tasks.filter:ws-1')).toBeNull();
  });

  it('re-reads when the workspace changes, without leaking the old value into the new key', () => {
    window.localStorage.setItem('agensis.tasks.filter:ws-2', 'others');
    render('ws-1');
    act(() => setFilter('mine'));
    expect(window.localStorage.getItem('agensis.tasks.filter:ws-1')).toBe('mine');

    renders = [];
    render('ws-2');
    // ws-2's own choice, immediately — and ws-1's 'mine' was not written over it.
    expect(renders[0]).toBe('others');
    expect(window.localStorage.getItem('agensis.tasks.filter:ws-2')).toBe('others');
    expect(window.localStorage.getItem('agensis.tasks.filter:ws-1')).toBe('mine');
  });

  it('falls back to the default for a workspace with a garbage key', () => {
    window.localStorage.setItem('agensis.tasks.filter:ws-1', '{"filter":"mine"}');
    render('ws-1');
    expect(renders[0]).toBe('all');
  });

  it('works in memory while there is no workspace, and stores nothing', () => {
    render(null);
    act(() => setFilter('mine'));
    expect(container.textContent).toBe('mine');
    expect(window.localStorage.length).toBe(0);
  });

  it('picks up the stored value once the workspace id arrives after boot', () => {
    window.localStorage.setItem('agensis.tasks.filter:ws-1', 'others');
    render(null);
    expect(container.textContent).toBe('all');
    render('ws-1');
    expect(container.textContent).toBe('others');
  });
});
