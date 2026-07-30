export type CursorBuddyGuideReviewStatus = 'draft' | 'pending' | 'approved' | 'rejected';

export interface CursorBuddyGuideSubmission {
  id: string;
  site_url: string;
  host: string;
  path_pattern: string;
  name: string;
  summary: string;
  review_status: CursorBuddyGuideReviewStatus;
  review_notes: string;
  submitted_at: string | null;
  reviewed_at: string | null;
  published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  manifest: Record<string, unknown>;
  owner: {
    id: string;
    email: string;
    display_name: string;
  };
}

export function guideSubmissionOwner(guide: CursorBuddyGuideSubmission): string {
  return guide.owner.display_name.trim() || guide.owner.email.trim() || 'Unknown account';
}

export function guideSubmissionMatch(guide: CursorBuddyGuideSubmission): string {
  return `${guide.host}${guide.path_pattern === '/*' ? '' : guide.path_pattern}`;
}

export function guideSubmissionDate(value: string | null): string {
  if (!value) return 'Not submitted';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown date';
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}
