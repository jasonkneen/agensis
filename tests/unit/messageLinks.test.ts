// Links in messages must be clickable, and message text must be selectable.
//
// Both failed at once and for unrelated reasons:
//
//   * Only `[label](href)` ever became an anchor. A bare URL — the form agents
//     actually write — rendered as plain text, and a URL inside backticks
//     rendered as a <code> span. Neither could be clicked.
//   * `[data-floating-window] { user-select: none }` exists so dragging a window
//     by its chrome moves it instead of painting a selection. It inherits into
//     the message list, so no message anywhere in the app could be copied.
//
// The selection half is a CSS fact, so it is asserted against the stylesheet
// source: there is no layout in jsdom to observe it any other way.

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { MarkdownContent, trimUrlTail } from '../../src/components/chat/MarkdownContent';

const render = (content: string) => renderToStaticMarkup(createElement(MarkdownContent, { content }));

describe('links in messages', () => {
  it('linkifies a bare URL — the form agents actually write', () => {
    const html = render('That https://ascii.dev/fire3e5cc756 link is your live viewer.');
    expect(html).toContain('href="https://ascii.dev/fire3e5cc756"');
    expect(html).toContain('target="_blank"');
  });

  it('linkifies a URL inside backticks, and keeps it looking like code', () => {
    // The exact case from the report: the agent wrote the URL in a code span.
    const html = render('You already have it — `https://ascii.dev/fire3e5cc756`');
    expect(html).toContain('href="https://ascii.dev/fire3e5cc756"');
    expect(html).toContain('<code>');
  });

  it('leaves sentence punctuation out of the href', () => {
    const html = render('Go to https://example.com/a. Then stop.');
    expect(html).toContain('href="https://example.com/a"');
    expect(html).not.toContain('href="https://example.com/a."');
  });

  it('does not swallow the paren that closes a parenthetical', () => {
    expect(trimUrlTail('https://example.com/a)')).toBe('https://example.com/a');
    // ...but a bracket the URL itself opened is part of the path.
    expect(trimUrlTail('https://example.com/a(b)')).toBe('https://example.com/a(b)');
  });

  it('still prefers an explicit markdown link over the bare-URL rule', () => {
    const html = render('[the viewer](https://example.com/v)');
    expect(html).toContain('href="https://example.com/v"');
    expect(html).toContain('>the viewer<');
    expect(html).not.toContain('>https://example.com/v<');
  });

  it('refuses a non-http scheme, so a message cannot ship a javascript: link', () => {
    const html = render('[click me](javascript:alert(1))');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('<a ');
  });

  it('never emits an empty href', () => {
    expect(trimUrlTail('https://.')).not.toBe('');
  });
});

describe('selecting message text', () => {
  const css = readFileSync(join(process.cwd(), 'src/index.css'), 'utf8');

  it('re-enables selection inside the window chrome that disables it', () => {
    // The chrome rule must stay — without it, dragging a window paints a
    // selection across the whole app instead of moving the window.
    expect(css).toMatch(/\[data-floating-window\]\s*\{\s*user-select:\s*none/);

    // A directly-matching declaration beats the inherited one. If this block is
    // ever dropped, every message in the app silently becomes uncopyable again.
    const selectable = css.slice(css.indexOf('[data-floating-window] {'));
    expect(selectable).toMatch(/\.chat-message-row,[\s\S]{0,400}user-select:\s*text/);
    expect(selectable).toMatch(/\.chat-markdown,/);
  });
});
