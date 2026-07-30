import { describe, expect, it } from 'vitest';
import type { DiagnosticsSnapshot } from '../../src/lib/feedbackDiagnostics';
import type { ElementDescriptor } from '../../src/lib/feedbackElement';
import {
  FEEDBACK_DESCRIPTION_MAX_CHARS,
  FEEDBACK_MAX_SELECTIONS,
  buildFeedbackSubmission,
  describeAttachments,
  isSubmittableFeedback,
} from '../../src/lib/feedbackReport';

const PAGE = { path: '/', hash: '#workspace', label: 'Personal' };

function selection(overrides: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    selector: '#tasks-panel > button',
    tag: 'button',
    role: 'button',
    text: 'Add task',
    rect: { x: 10, y: 20, width: 80, height: 32 },
    ...overrides,
  };
}

function diagnostics(overrides: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    buildId: 'abc123',
    userAgent: 'Mozilla/5.0',
    url: 'https://agensis.io/',
    viewport: { width: 1440, height: 900 },
    language: 'en-GB',
    capturedAt: '2026-07-26T10:00:00.000Z',
    console: [{ level: 'log', message: 'ready', at: 1 }],
    errors: [],
    truncated: false,
    ...overrides,
  };
}

describe('buildFeedbackSubmission', () => {
  it('carries the pre-filled context the reporter should not have to type', () => {
    const submission = buildFeedbackSubmission({
      description: 'The dock overlaps the composer',
      workspaceId: 'ws-1',
      page: PAGE,
    });
    expect(submission.workspaceId).toBe('ws-1');
    expect(submission.page).toEqual(PAGE);
    expect(submission.description).toBe('The dock overlaps the composer');
  });

  it('redacts the user\'s own prose — people paste headers into free-text boxes', () => {
    const submission = buildFeedbackSubmission({
      description: 'it 401s, my curl was: -H "Authorization: Bearer 3f2a9c1e-7b4d-4e8a-9f01-2c3d4e5f6a7b.4.1785000000.Zm9vYmFyYmF6cXV4MTIzNDU2"',
      page: PAGE,
    });
    expect(submission.description).not.toContain('Zm9vYmFy');
    expect(submission.description).toContain('401s');
  });

  it('redacts a selector and its captured text', () => {
    const submission = buildFeedbackSubmission({
      description: 'broken',
      page: PAGE,
      selections: [selection({ text: 'token aga_9f8e7d6c5b4a39281706' })],
    });
    expect(JSON.stringify(submission)).not.toContain('aga_9f8e7d6c5b4a');
  });

  it('caps the description', () => {
    const submission = buildFeedbackSubmission({ description: 'x'.repeat(9000), page: PAGE });
    expect(submission.description).toHaveLength(FEEDBACK_DESCRIPTION_MAX_CHARS);
  });

  it('caps the number of selections', () => {
    const submission = buildFeedbackSubmission({
      description: 'broken',
      page: PAGE,
      selections: Array.from({ length: 12 }, () => selection()),
    });
    expect(submission.selections).toHaveLength(FEEDBACK_MAX_SELECTIONS);
  });

  it('omits diagnostics entirely when the user unticks the switch', () => {
    const submission = buildFeedbackSubmission({
      description: 'broken',
      page: PAGE,
      diagnostics: diagnostics(),
      includeDiagnostics: false,
    });
    // Consent means the toggle actually removes the payload, not just hides it.
    expect(submission.diagnostics).toBeNull();
    expect(JSON.stringify(submission)).not.toContain('Mozilla');
  });

  it('includes diagnostics by default', () => {
    const submission = buildFeedbackSubmission({ description: 'broken', page: PAGE, diagnostics: diagnostics() });
    expect(submission.diagnostics?.buildId).toBe('abc123');
  });

  it('tolerates a missing page object rather than throwing mid-submit', () => {
    const submission = buildFeedbackSubmission({
      description: 'broken',
      page: undefined as unknown as typeof PAGE,
    });
    expect(submission.page).toEqual({ path: '', hash: '', label: '' });
  });
});

describe('isSubmittableFeedback', () => {
  it('rejects empty or trivial descriptions', () => {
    expect(isSubmittableFeedback(buildFeedbackSubmission({ description: '   ', page: PAGE }))).toBe(false);
    expect(isSubmittableFeedback(buildFeedbackSubmission({ description: 'ok', page: PAGE }))).toBe(false);
    expect(isSubmittableFeedback(buildFeedbackSubmission({ description: 'broken', page: PAGE }))).toBe(true);
  });
});

describe('describeAttachments — the consent sentence', () => {
  it('says plainly that nothing is attached', () => {
    const submission = buildFeedbackSubmission({ description: 'broken', page: PAGE, includeDiagnostics: false });
    expect(describeAttachments(submission)).toBe('Nothing attached — just your description.');
  });

  it('counts elements, console lines and errors', () => {
    const submission = buildFeedbackSubmission({
      description: 'broken',
      page: PAGE,
      selections: [selection(), selection()],
      diagnostics: diagnostics({
        console: [{ level: 'log', message: 'a', at: 1 }, { level: 'warn', message: 'b', at: 2 }],
        errors: [{ kind: 'error', message: 'boom', source: '', at: 3 }],
      }),
    });
    const summary = describeAttachments(submission);
    expect(summary).toContain('2 elements');
    expect(summary).toContain('2 console lines');
    expect(summary).toContain('1 error');
  });

  it('uses singular forms for one of each', () => {
    const submission = buildFeedbackSubmission({
      description: 'broken',
      page: PAGE,
      selections: [selection()],
      diagnostics: diagnostics(),
    });
    const summary = describeAttachments(submission);
    expect(summary).toContain('1 element,');
    expect(summary).toContain('1 console line');
  });
});
