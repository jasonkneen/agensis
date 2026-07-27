import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownContent } from '../../src/components/chat/MarkdownContent';

// An agent's soul, system prompt, instructions and description are MARKDOWN
// documents — the daemon mirrors a soul to disk as soul.md — but both places a
// human drills into them (the Agents detail pane and the agent profile panel)
// rendered them pre-wrapped, so a heading arrived on screen as a literal "#"
// and a bullet as a literal "-".
//
// These assert the renderer those surfaces now use actually produces ELEMENTS,
// and — the part a typecheck cannot see — that it never injects HTML, which
// matters because the agent writes its own soul.

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

function render(content: string) {
  act(() => { root.render(createElement(MarkdownContent, { content, compact: true })); });
}

describe('agent detail fields render as markdown, not source', () => {
  it('a heading becomes a heading element, not a literal hash', () => {
    render('# Operating rules\n\nBe precise.');
    expect(container.querySelector('h1, h2, h3')).not.toBeNull();
    expect(container.textContent).toContain('Operating rules');
    expect(container.textContent).not.toContain('# Operating rules');
  });

  it('a bullet list becomes list items, not literal dashes', () => {
    render('- read the logs\n- then change the code');
    expect(container.querySelectorAll('li').length).toBe(2);
    expect(container.textContent).not.toContain('- read the logs');
  });

  it('emphasis becomes markup, not literal asterisks', () => {
    render('Never **guess** at a fix.');
    expect(container.querySelector('strong, b')).not.toBeNull();
    expect(container.textContent).not.toContain('**guess**');
  });

  it('does NOT execute HTML in an agent-authored soul', () => {
    // The soul is written by the AGENT. If this renderer ever gained an
    // innerHTML path, this is the surface that would be exploited first.
    render('Hello <img src=x onerror="window.__pwned=1"> world');
    expect(container.querySelector('img')).toBeNull();
    expect((globalThis as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('empty content renders without throwing — most agents have no soul yet', () => {
    expect(() => render('')).not.toThrow();
  });
});
