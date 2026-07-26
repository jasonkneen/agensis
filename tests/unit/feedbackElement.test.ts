import { afterEach, describe, expect, it } from 'vitest';
import {
  ELEMENT_TEXT_MAX_CHARS,
  cssSelectorForElement,
  describeElement,
  elementChipLabel,
  isStableId,
  visibleTextFor,
} from '../../src/lib/feedbackElement';

// The selector has to still mean something when a human reads the report days
// later, on a build that has since been restyled and redeployed. So the tests
// below are less about "produces a selector" and more about "refuses to build
// one out of things that will not survive" — generated ids and utility classes.

function mount(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('isStableId', () => {
  it('accepts a hand-written id', () => {
    expect(isStableId('feedback-description')).toBe(true);
    expect(isStableId('workspace_name')).toBe(true);
  });

  it('rejects framework-generated ids', () => {
    // Radix and React useId ids change every render — a selector built from one
    // looks authoritative and never matches again.
    expect(isStableId(':r3:')).toBe(false);
    expect(isStableId('radix-:r7:')).toBe(false);
    expect(isStableId('R2ab')).toBe(false);
    expect(isStableId('3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b')).toBe(false);
    expect(isStableId('')).toBe(false);
  });
});

describe('cssSelectorForElement', () => {
  it('stops at a stable id', () => {
    const host = mount('<section id="tasks-panel"><div><button>Add</button></div></section>');
    const button = host.querySelector('button')!;
    const selector = cssSelectorForElement(button);
    expect(selector).toBe('#tasks-panel > div > button');
    expect(document.querySelector(selector)).toBe(button);
  });

  it('ignores a generated id and falls back to structure', () => {
    const host = mount('<div id="radix-:r1:"><span>hi</span></div>');
    const span = host.querySelector('span')!;
    expect(cssSelectorForElement(span)).not.toContain('radix');
  });

  it('prefers the data-* hooks this codebase treats as contracts', () => {
    const host = mount('<div data-slot="dialog-content"><p>Body</p></div>');
    const paragraph = host.querySelector('p')!;
    const selector = cssSelectorForElement(paragraph);
    expect(selector).toContain('[data-slot="dialog-content"]');
    expect(document.querySelector(selector)).toBe(paragraph);
  });

  it('handles a valueless marker attribute', () => {
    const host = mount('<main data-workspace-viewport><span>x</span></main>');
    const selector = cssSelectorForElement(host.querySelector('span')!);
    expect(selector).toContain('main[data-workspace-viewport]');
  });

  it('disambiguates siblings with nth-of-type', () => {
    const host = mount('<ul id="list"><li>a</li><li>b</li><li>c</li></ul>');
    const second = host.querySelectorAll('li')[1];
    const selector = cssSelectorForElement(second);
    expect(selector).toContain(':nth-of-type(2)');
    expect(document.querySelector(selector)).toBe(second);
  });

  it('never builds a selector out of utility classes', () => {
    const host = mount('<div class="flex min-w-0 items-center gap-2 rounded-xl"><b>x</b></div>');
    const selector = cssSelectorForElement(host.querySelector('b')!);
    // Class chains in this codebase change on every restyle.
    expect(selector).not.toContain('.flex');
    expect(selector).not.toContain('rounded-xl');
  });

  it('returns empty for null', () => {
    expect(cssSelectorForElement(null)).toBe('');
  });
});

describe('visibleTextFor — the privacy boundary', () => {
  it('NEVER reads an input value', () => {
    const host = mount('<input id="pw" type="password" placeholder="Password" />');
    const input = host.querySelector('input')!;
    input.value = 'hunter2-the-real-password';
    const text = visibleTextFor(input);
    // A bug report about a login form must not carry what was typed into it.
    expect(text).not.toContain('hunter2');
    expect(text).toBe('Password');
  });

  it('uses the label, placeholder or name for a textarea', () => {
    const host = mount('<textarea aria-label="Message"></textarea>');
    const textarea = host.querySelector('textarea')!;
    textarea.value = 'draft the user has not sent';
    expect(visibleTextFor(textarea)).toBe('Message');
  });

  it('collapses whitespace and caps long text', () => {
    const host = mount(`<p>${'word '.repeat(80)}</p>`);
    const text = visibleTextFor(host.querySelector('p')!);
    expect(text.length).toBeLessThanOrEqual(ELEMENT_TEXT_MAX_CHARS + 1);
    expect(text).not.toContain('\n');
  });
});

describe('describeElement', () => {
  it('captures selector, role and position without any input value', () => {
    const host = mount('<button id="send-btn" aria-label="Send">Send feedback</button>');
    const descriptor = describeElement(host.querySelector('button')!);
    expect(descriptor.selector).toBe('#send-btn');
    expect(descriptor.tag).toBe('button');
    expect(descriptor.role).toBe('button');
    expect(descriptor.text).toBe('Send feedback');
    expect(descriptor.rect).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('redacts a token that happens to be rendered on the page', () => {
    const host = mount('<code>aga_9f8e7d6c5b4a39281706</code>');
    const descriptor = describeElement(host.querySelector('code')!);
    expect(descriptor.text).not.toContain('aga_9f8e7d6c5b4a');
  });

  it('builds a short chip label', () => {
    const host = mount('<button>Save</button>');
    expect(elementChipLabel(describeElement(host.querySelector('button')!))).toBe('<button> "Save"');
  });
});
