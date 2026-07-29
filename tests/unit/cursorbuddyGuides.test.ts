import { describe, expect, it } from 'vitest';
import {
  guideSubmissionDate,
  guideSubmissionMatch,
  guideSubmissionOwner,
  type CursorBuddyGuideSubmission,
} from '../../src/lib/cursorbuddyGuides';

function guide(overrides: Partial<CursorBuddyGuideSubmission> = {}): CursorBuddyGuideSubmission {
  return {
    id: 'guide-1',
    site_url: 'https://docs.example.com/start',
    host: 'docs.example.com',
    path_pattern: '/start*',
    name: 'Example',
    summary: '',
    review_status: 'pending',
    review_notes: '',
    submitted_at: '2026-07-29T12:00:00.000Z',
    reviewed_at: null,
    published_at: null,
    created_at: null,
    updated_at: null,
    manifest: {},
    owner: { id: 'user-1', email: 'person@example.com', display_name: 'Pat Example' },
    ...overrides,
  };
}

describe('CursorBuddy guide review labels', () => {
  it('shows the exact host and path match', () => {
    expect(guideSubmissionMatch(guide())).toBe('docs.example.com/start*');
    expect(guideSubmissionMatch(guide({ path_pattern: '/*' }))).toBe('docs.example.com');
  });

  it('uses display name, then email, without exposing account ids', () => {
    expect(guideSubmissionOwner(guide())).toBe('Pat Example');
    expect(guideSubmissionOwner(guide({ owner: { id: 'user-1', email: 'person@example.com', display_name: '' } })))
      .toBe('person@example.com');
  });

  it('handles absent and invalid timestamps', () => {
    expect(guideSubmissionDate(null)).toBe('Not submitted');
    expect(guideSubmissionDate('invalid')).toBe('Unknown date');
    expect(guideSubmissionDate('2026-07-29T12:00:00.000Z')).not.toBe('Unknown date');
  });
});
