import { describe, expect, it } from 'vitest';
import {
  LINKED_DOCUMENT_BODY_MAX_CHARS,
  LINKED_DOCUMENT_MAX_CHARS,
  linkedDocumentContext,
  prependLinkedDocumentContext,
} from '../../src/lib/linkedDocumentContext';
import type { Document } from '../../src/types';

function document(id: string, title: string, content: string): Document {
  return { id, title, content } as Document;
}

describe('linked document prompt context', () => {
  it('includes document bodies as bounded plain text in a sub-thread send', () => {
    const result = prependLinkedDocumentContext('Please review this', [
      document('one', 'Design', '<h1>Architecture</h1><p>Keep agents isolated.</p>'),
      document('two', '', '<strong>Fallback body</strong>'),
    ]);

    expect(result).toContain('[Linked documents]');
    expect(result).toContain('--- Document: Design ---');
    expect(result).toContain('Architecture Keep agents isolated.');
    expect(result).toContain('--- Document: Untitled ---');
    expect(result).not.toMatch(/<h1>|<p>|<strong>/);
    expect(result.endsWith('\n\nPlease review this')).toBe(true);
  });

  it('bounds each body and the aggregate context', () => {
    const huge = 'x'.repeat(LINKED_DOCUMENT_BODY_MAX_CHARS * 3);
    const context = linkedDocumentContext([
      document('one', 'One', huge),
      document('two', 'Two', huge),
      document('three', 'Three', huge),
    ]);
    expect(context.length).toBeLessThanOrEqual(LINKED_DOCUMENT_MAX_CHARS);
    expect(context).toContain('--- Document: One ---');
    expect(prependLinkedDocumentContext('hello', [])).toBe('hello');
  });
});
