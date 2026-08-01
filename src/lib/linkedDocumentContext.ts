import type { Document } from '../types';

export const LINKED_DOCUMENT_MAX_CHARS = 24_000;
export const LINKED_DOCUMENT_BODY_MAX_CHARS = 12_000;

export function linkedDocumentContext(documents: readonly Document[]): string {
  return documents
    .map(document => {
      const body = String(document.content || '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LINKED_DOCUMENT_BODY_MAX_CHARS);
      return `--- Document: ${document.title || 'Untitled'} ---\n${body}`;
    })
    .join('\n\n')
    .slice(0, LINKED_DOCUMENT_MAX_CHARS);
}

export function prependLinkedDocumentContext(
  content: string,
  documents: readonly Document[],
): string {
  if (documents.length === 0) return content;
  const context = linkedDocumentContext(documents);
  return `[Linked documents]\n${context}\n\n${content}`;
}
