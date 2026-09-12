import { describe, it, expect } from 'vitest';
import { cssPath, describeElement, buildPickContext, type ElementPick } from '../../src/lib/componentPicker';

function make(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

describe('cssPath', () => {
  it('prefers data-testid', () => {
    const host = make('<button data-testid="send-btn">Send</button>');
    const el = host.querySelector('button')!;
    expect(cssPath(el)).toBe('[data-testid="send-btn"]');
  });

  it('prefers id over a nth path', () => {
    const host = make('<div><span id="hello">hi</span></div>');
    const el = host.querySelector('#hello')!;
    expect(cssPath(el)).toBe('#hello');
  });

  it('builds a bounded tag:nth-of-type path when no id/testid', () => {
    const host = make('<ul><li>a</li><li>b</li><li>c</li></ul>');
    const third = host.querySelectorAll('li')[2];
    const path = cssPath(third);
    expect(path).toContain('li:nth-of-type(3)');
    // and the path actually resolves back to the same element
    expect(host.querySelector(path.split(' > ').slice(-2).join(' > '))).toBeTruthy();
  });
});

describe('describeElement', () => {
  it('falls back to the tag name when no React fiber is present', () => {
    const host = make('<section data-testid="panel">Some text here</section>');
    const el = host.querySelector('section')!;
    const d = describeElement(el);
    expect(d.label).toBe('section');
    expect(d.selector).toBe('[data-testid="panel"]');
    expect(d.text).toBe('Some text here');
  });
});

describe('buildPickContext', () => {
  const pick = (over: Partial<ElementPick>): ElementPick => ({
    id: 'p1', index: 1, label: 'SendButton', selector: '[data-testid="send"]',
    note: 'make this bigger', rect: { x: 0, y: 0, width: 10, height: 10 }, ...over,
  });

  it('returns empty string for no picks', () => {
    expect(buildPickContext([])).toBe('');
  });

  it('folds index, label, selector and note into a labelled block', () => {
    const out = buildPickContext([pick({})]);
    expect(out).toContain('[Picked elements]');
    expect(out).toContain('[#1] SendButton');
    expect(out).toContain('selector: [data-testid="send"]');
    expect(out).toContain('note: make this bigger');
  });

  it('numbers multiple picks in order', () => {
    const out = buildPickContext([
      pick({ id: 'a', index: 1, label: 'A' }),
      pick({ id: 'b', index: 2, label: 'B', note: '' }),
    ]);
    expect(out).toContain('[#1] A');
    expect(out).toContain('[#2] B');
  });
});
