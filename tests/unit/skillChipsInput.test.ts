import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SkillChipsInput } from '../../src/components/agents/SkillChipsInput';
import type { SkillSuggestion } from '../../src/lib/skillTokens';

// The drawing, not the decisions — those are covered in skillTokens.test.ts.
// What this asserts is that the real component is WIRED to them: that the x
// removes a chip, that Backspace on an empty input does, that the menu opens and
// filters, and — the load-bearing one — that merely looking at the field never
// calls onChange, because the edit form's sparse diff is only safe while an
// untouched field's value is byte-identical to what seeded it.

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

const suggestions: SkillSuggestion[] = [
  { value: 'deploy-targets', label: 'deploy-targets', detail: '2 agents' },
  { value: 'aws-sandbox', label: 'aws-sandbox', detail: 'In agensis' },
  { value: 'codex-user-skills', label: 'Codex user skills', detail: 'Library · 12' },
];

function render(value: string, onChange: (next: string) => void) {
  act(() => {
    root.render(createElement(SkillChipsInput, { id: 'agent-skills', value, onChange, suggestions }));
  });
}

const input = () => container.querySelector('input') as HTMLInputElement;
const chips = () => [...container.querySelectorAll('button[aria-label^="Remove "]')];
const menuRows = () => [...container.querySelectorAll('[role="option"]')];

function type(text: string) {
  const el = input();
  act(() => {
    // React tracks the DOM value to decide whether onChange fires at all.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

// React binds onFocus/onBlur to the bubbling focusin/focusout pair, so a bare
// 'focus' event would never reach the handler.
function focus() {
  act(() => { input().dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
}

function blur() {
  act(() => { input().dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
}

function press(key: string) {
  act(() => { input().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
}

describe('SkillChipsInput draws chips', () => {
  it('turns the comma-separated value into one chip per skill', () => {
    render('deploy-targets, aws-sandbox', vi.fn());
    expect(chips().map(b => b.getAttribute('aria-label')))
      .toEqual(['Remove deploy-targets', 'Remove aws-sandbox']);
  });

  it('removes a chip with its x, and writes back the remaining value', () => {
    const onChange = vi.fn();
    render('deploy-targets, aws-sandbox', onChange);
    act(() => { chips()[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('aws-sandbox');
  });

  it('uses an icon for the x, never a glyph in the platform emoji font', () => {
    render('deploy-targets', vi.fn());
    expect(chips()[0].querySelector('svg')).toBeTruthy();
    expect(chips()[0].textContent).toBe('');
  });
});

describe('SkillChipsInput suggests as you type', () => {
  it('opens the whole list on focus, so it is browsable like the old buttons', () => {
    render('', vi.fn());
    focus();
    expect(menuRows().map(r => r.textContent)).toHaveLength(3);
  });

  it('narrows to what was typed', () => {
    render('', vi.fn());
    type('sand');
    const rows = menuRows().map(r => r.textContent || '');
    expect(rows[0]).toContain('aws-sandbox');
    expect(rows.some(r => r.includes('deploy-targets'))).toBe(false);
  });

  it('Enter commits the top match', () => {
    const onChange = vi.fn();
    render('', onChange);
    type('depl');
    press('Enter');
    expect(onChange).toHaveBeenCalledWith('deploy-targets');
  });

  it('clicking a row commits it', () => {
    const onChange = vi.fn();
    render('deploy-targets', onChange);
    type('aws');
    act(() => { menuRows()[0].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); });
    expect(onChange).toHaveBeenCalledWith('deploy-targets, aws-sandbox');
  });

  it('accepts a name nothing has heard of', () => {
    const onChange = vi.fn();
    render('', onChange);
    type('my-private-skill');
    expect(menuRows()).toHaveLength(1);
    expect(menuRows()[0].textContent).toContain('Add "my-private-skill"');
    press('Enter');
    expect(onChange).toHaveBeenCalledWith('my-private-skill');
  });

  it('never offers a skill that is already a chip', () => {
    render('deploy-targets', vi.fn());
    focus();
    expect(menuRows().some(r => r.textContent?.includes('deploy-targets'))).toBe(false);
  });

  it('cannot add the same skill twice', () => {
    const onChange = vi.fn();
    render('deploy-targets', onChange);
    type('deploy-targets');
    press('Enter');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Escape closes the menu without changing anything', () => {
    const onChange = vi.fn();
    render('', onChange);
    type('depl');
    expect(menuRows().length).toBeGreaterThan(0);
    press('Escape');
    expect(menuRows()).toHaveLength(0);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('arrows move the highlight', () => {
    const onChange = vi.fn();
    render('', onChange);
    focus();
    press('ArrowDown');
    press('ArrowDown');
    expect(menuRows()[1].getAttribute('aria-selected')).toBe('true');
    press('Enter');
    expect(onChange).toHaveBeenCalledWith('aws-sandbox');
  });
});

describe('SkillChipsInput keyboard removal', () => {
  it('Backspace on an empty input removes the last chip', () => {
    const onChange = vi.fn();
    render('deploy-targets, aws-sandbox', onChange);
    press('Backspace');
    expect(onChange).toHaveBeenCalledWith('deploy-targets');
  });

  it('Backspace with text in the input does not eat a chip', () => {
    const onChange = vi.fn();
    render('deploy-targets', onChange);
    type('aw');
    press('Backspace');
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe('the sparse diff survives', () => {
  // The edit form sends only the fields whose value changed. The Skills field's
  // value is a string in that form's state, so the ONLY way an untouched field
  // can end up in the patch is this component calling onChange when nobody
  // edited anything.
  it('never writes back from looking at it — focus, arrows, escape, blur', () => {
    const onChange = vi.fn();
    render('deploy-targets, aws-sandbox', onChange);
    focus();
    press('ArrowDown');
    press('ArrowUp');
    press('Escape');
    blur();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('never writes back on mount, however ragged the stored value is', () => {
    const onChange = vi.fn();
    render(' deploy-targets ,, aws-sandbox ', onChange);
    expect(chips()).toHaveLength(2);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('typing without committing does not write back either', () => {
    const onChange = vi.fn();
    render('deploy-targets', onChange);
    type('aws');
    expect(onChange).not.toHaveBeenCalled();
  });
});
