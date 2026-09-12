import { describe, it, expect } from 'vitest';
import { cssPath, describeElement, buildPickContext, parsePickContext, type ElementPick } from '../../src/lib/componentPicker';

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

describe('parsePickContext', () => {
  const pick = (over: Partial<ElementPick>): ElementPick => ({
    id: 'p1', index: 1, label: 'SendButton', selector: '[data-testid="send"]',
    note: 'make this bigger', rect: { x: 0, y: 0, width: 10, height: 10 }, ...over,
  });

  it('passes ordinary messages through untouched', () => {
    const { picks, body } = parsePickContext('just a normal message');
    expect(picks).toEqual([]);
    expect(body).toBe('just a normal message');
  });

  it('round-trips a single pick built by buildPickContext, splitting off the body', () => {
    const block = buildPickContext([pick({ component: 'Button', text: 'Send' })]);
    const { picks, body } = parsePickContext(`${block}\n\nplease enlarge this`);
    expect(body).toBe('please enlarge this');
    expect(picks).toHaveLength(1);
    expect(picks[0]).toMatchObject({
      index: 1,
      label: 'SendButton',
      component: 'Button',
      text: 'Send',
      selector: '[data-testid="send"]',
      note: 'make this bigger',
    });
  });

  it('parses a pick-only message (no trailing body)', () => {
    const block = buildPickContext([pick({})]);
    const { picks, body } = parsePickContext(block);
    expect(body).toBe('');
    expect(picks).toHaveLength(1);
    expect(picks[0].selector).toBe('[data-testid="send"]');
  });

  it('recovers each field across multiple picks', () => {
    const block = buildPickContext([
      pick({ id: 'a', index: 1, label: 'A', component: undefined, text: undefined, note: 'first' }),
      pick({ id: 'b', index: 2, label: 'B', note: '' }),
    ]);
    const { picks } = parsePickContext(`${block}\n\nbody`);
    expect(picks).toHaveLength(2);
    expect(picks[0]).toMatchObject({ index: 1, label: 'A', note: 'first' });
    expect(picks[0].component).toBeUndefined();
    expect(picks[1]).toMatchObject({ index: 2, label: 'B' });
    expect(picks[1].note).toBeUndefined(); // an empty note is not emitted, so not parsed back
  });

  it('round-trips a multiline note (single newlines) without losing continuation lines', () => {
    const note = 'first line\nsecond line\nthird line';
    const block = buildPickContext([pick({ note })]);
    const { picks, body } = parsePickContext(`${block}\n\nthe body`);
    expect(body).toBe('the body');
    expect(picks).toHaveLength(1);
    expect(picks[0].note).toBe(note);
  });

  it('round-trips a note containing a blank line, keeping it out of the message body', () => {
    // A blank line inside the note previously produced a "\n\n" that the parser
    // read as the block/body seam — truncating the note and stealing the rest
    // into the body. It must now survive as part of the note.
    const note = 'paragraph one\n\nparagraph two';
    const block = buildPickContext([pick({ note })]);
    const { picks, body } = parsePickContext(`${block}\n\nthe real body`);
    expect(body).toBe('the real body');
    expect(picks).toHaveLength(1);
    expect(picks[0].note).toBe(note);
  });

  it('round-trips a multiline note on a pick-only message (no body)', () => {
    const note = 'line one\nline two\n\nline four';
    const block = buildPickContext([pick({ note })]);
    const { picks, body } = parsePickContext(block);
    expect(body).toBe('');
    expect(picks).toHaveLength(1);
    expect(picks[0].note).toBe(note);
  });

  it('keeps a multiline note attached to the right pick among several', () => {
    const block = buildPickContext([
      pick({ id: 'a', index: 1, label: 'A', note: 'multi\nline' }),
      pick({ id: 'b', index: 2, label: 'B', note: 'single' }),
    ]);
    const { picks } = parsePickContext(`${block}\n\nbody`);
    expect(picks[0].note).toBe('multi\nline');
    expect(picks[1].note).toBe('single');
    expect(picks[1].selector).toBe('[data-testid="send"]');
  });
});
