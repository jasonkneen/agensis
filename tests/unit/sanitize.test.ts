import { describe, it, expect } from 'vitest';
import { sanitizeHtml } from '../../src/lib/sanitize';

// Item 3 — XSS roundtrip for the centralized rich-text sanitizer.
// jsdom provides the DOM that DOMPurify needs (vitest environment: 'jsdom').

describe('sanitizeHtml — strips dangerous content', () => {
  it('removes <script> entirely', () => {
    const out = sanitizeHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).toContain('hi');
    expect(out.toLowerCase()).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('keeps <img> but drops the onerror handler', () => {
    const out = sanitizeHtml('<img src="x" onerror="alert(1)">');
    expect(out.toLowerCase()).toContain('<img');
    expect(out.toLowerCase()).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('strips inline onclick / onmouseover handlers', () => {
    const out = sanitizeHtml(
      '<div onclick="steal()" onmouseover="track()">text</div>',
    );
    expect(out).toContain('text');
    expect(out.toLowerCase()).not.toContain('onclick');
    expect(out.toLowerCase()).not.toContain('onmouseover');
  });

  it('strips javascript: URLs in href', () => {
    const out = sanitizeHtml('<a href="javascript:alert(1)">click</a>');
    expect(out).toContain('click');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('strips <iframe>', () => {
    const out = sanitizeHtml('<iframe src="https://evil.example"></iframe>');
    expect(out.toLowerCase()).not.toContain('<iframe');
  });

  it('strips <form>', () => {
    const out = sanitizeHtml('<form action="/steal"><input name="x"></form>');
    expect(out.toLowerCase()).not.toContain('<form');
  });
});

describe('sanitizeHtml — preserves allowed rich text', () => {
  it('keeps <strong>', () => {
    const out = sanitizeHtml('<strong>bold</strong>');
    expect(out).toContain('<strong>bold</strong>');
  });

  it('keeps safe <a href> and adds rel/target safety attrs', () => {
    const out = sanitizeHtml('<a href="https://example.com">link</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer nofollow"');
  });

  it('keeps lists', () => {
    const out = sanitizeHtml('<ul><li>one</li><li>two</li></ul>');
    expect(out.toLowerCase()).toContain('<ul>');
    expect(out.toLowerCase()).toContain('<li>one</li>');
  });

  it('keeps tables', () => {
    const out = sanitizeHtml(
      '<table><thead><tr><th>H</th></tr></thead><tbody><tr><td>C</td></tr></tbody></table>',
    );
    expect(out.toLowerCase()).toContain('<table>');
    expect(out.toLowerCase()).toContain('<th>h</th>');
    expect(out.toLowerCase()).toContain('<td>c</td>');
  });
});

describe('sanitizeHtml — preserves allowlisted interactive blocks', () => {
  it('keeps <canvas>', () => {
    const out = sanitizeHtml('<canvas width="100" height="50"></canvas>');
    expect(out.toLowerCase()).toContain('<canvas');
  });

  it('keeps <textarea>', () => {
    const out = sanitizeHtml('<textarea rows="3">note</textarea>');
    expect(out.toLowerCase()).toContain('<textarea');
    expect(out).toContain('note');
  });

  it('keeps <button>', () => {
    const out = sanitizeHtml('<button type="button">go</button>');
    expect(out.toLowerCase()).toContain('<button');
    expect(out).toContain('go');
  });

  it('keeps <input type="checkbox" checked>', () => {
    const out = sanitizeHtml('<input type="checkbox" checked>');
    expect(out.toLowerCase()).toContain('<input');
    expect(out.toLowerCase()).toContain('type="checkbox"');
    expect(out.toLowerCase()).toContain('checked');
  });
});

describe('sanitizeHtml — edge cases', () => {
  it('returns empty string for nullish input', () => {
    expect(sanitizeHtml(null)).toBe('');
    expect(sanitizeHtml(undefined)).toBe('');
    expect(sanitizeHtml('')).toBe('');
  });
});
