import { beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MarkdownContent } from '../../src/components/chat/MarkdownContent';

// Skill content is UNTRUSTED text. It is a SKILL.md read off somebody's laptop,
// or a definition an agent authored into its own metadata — neither is written
// by agensis, and both reach the Skills window verbatim. This asserts the same
// property agentDetailMarkdown.test.ts asserts for an agent's soul, on the
// renderer this pane uses: elements are built, HTML is never injected.

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

describe('skill content renders as markdown, never as HTML', () => {
  it('does NOT execute HTML in a skill body', () => {
    render('# Deploy\n\n<img src=x onerror="window.__skillPwned=1">\n');
    expect(container.querySelector('img')).toBeNull();
    expect((globalThis as unknown as { __skillPwned?: number }).__skillPwned).toBeUndefined();
  });

  it('does NOT execute a script tag smuggled into a skill body', () => {
    render('Setup:\n\n<script>window.__skillScript=1</script>\n');
    expect(container.querySelector('script')).toBeNull();
    expect((globalThis as unknown as { __skillScript?: number }).__skillScript).toBeUndefined();
  });

  it('renders a SKILL.md heading and code fence as elements', () => {
    render('# Deploy targets\n\n```bash\nfly deploy\n```\n');
    expect(container.querySelector('h1, h2, h3')).not.toBeNull();
    expect(container.textContent).toContain('fly deploy');
    expect(container.textContent).not.toContain('```');
  });

  it('renders the YAML frontmatter every SKILL.md starts with', () => {
    // agentskills.io files open with a `---` block. Left unparsed it would show
    // as three dashes and a wall of key: value lines above the actual body.
    render('---\nname: deploy-targets\ndescription: Which deploy a change needs.\n---\n\n# Deploy targets\n');
    // The header titles the name and surfaces the description; neither the
    // fences nor the raw `key: value` lines survive.
    expect(container.textContent).toContain('Which deploy a change needs.');
    expect(container.textContent).not.toContain('---');
    expect(container.textContent).not.toContain('name: deploy-targets');
  });

  it('renders an empty body without throwing', () => {
    expect(() => render('')).not.toThrow();
  });
});
