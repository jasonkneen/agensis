import { describe, expect, it } from 'vitest';
import { docBodyToHtml, looksLikeMarkdown } from '../../src/lib/docBody';

// Agents write documents in markdown; the editor is an HTML contentEditable.
// "The Agent Loop" showed `# The Agent Loop An **agent loop** is…` with table
// pipes and code fences as literal text — one run-on paragraph.
const AGENT_DOC = `# The Agent Loop

An **agent loop** is the cycle a model-driven agent runs.

## The steps

| # | Step | What happens |
|---|------|--------------|
| 1 | **Gather context** | Build the prompt |
| 2 | **Reason** | The model reads the context |

- thinks
- acts

\`\`\`python
def agent_loop(goal):
    return goal
\`\`\`
`;

describe('docBodyToHtml', () => {
  it('renders an agent-written markdown document as structure, not literal syntax', () => {
    const html = docBodyToHtml(AGENT_DOC);
    expect(html).toContain('<h1');
    expect(html).toContain('<h2');
    expect(html).toContain('<strong>agent loop</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>thinks</li>');
    expect(html).toMatch(/<pre><code[^>]*>def agent_loop/);
    expect(html).not.toContain('**');
    expect(html).not.toContain('|---');
  });

  it('leaves an HTML document exactly as the editor saved it', () => {
    const saved = '<h1>Notes</h1><p>Some <strong>bold</strong> text with a # hash and *stars*.</p>';
    expect(looksLikeMarkdown(saved)).toBe(false);
    expect(docBodyToHtml(saved)).toBe(saved);
  });

  it('leaves plain prose alone', () => {
    expect(looksLikeMarkdown('Just a sentence about 3 things.')).toBe(false);
    expect(docBodyToHtml('')).toBe('');
  });

  it('still sanitizes what markdown produces', () => {
    const html = docBodyToHtml('# Title\n\n<script>alert(1)</script>\n\n**ok**');
    expect(html).not.toContain('<script');
    expect(html).toContain('<strong>ok</strong>');
  });
});
