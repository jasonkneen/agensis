// ---------------------------------------------------------------------------
// OWNER BROADCASTS (browser half).
//
// The decision layer — which accounts a segment selects — lives ONLY in
// shared/tenant-campaigns.cjs and runs on the server. This file deliberately
// contains no matcher and no predicate: the count the owner confirms has to be
// the count the server sends to, and a browser copy of the evaluator would be a
// second answer that could disagree with it. The composer asks
// /backend/tenants/campaigns/preview for both the number and the list.
//
// What IS here is presentation and the guards around the send button: labels for
// the three surfaces, the same length caps the server enforces (so the composer
// can say "12 left" instead of silently truncating on submit), and the pure
// predicate for whether a composed message may be sent at all.
// ---------------------------------------------------------------------------

/** Where a message appears. One per campaign, chosen by the sender. */
export type CampaignSurface = 'tip' | 'dialog' | 'banner';

export const CAMPAIGN_SURFACES: readonly CampaignSurface[] = ['tip', 'dialog', 'banner'];

/** Must match MAX_TITLE_LENGTH / MAX_BODY_LENGTH in shared/tenant-campaigns.cjs. */
export const MAX_TITLE_LENGTH = 120;
export const MAX_BODY_LENGTH = 1000;

export interface CampaignSurfaceInfo {
  id: CampaignSurface;
  label: string;
  /** What the recipient actually sees, in the recipient's terms. */
  description: string;
}

export const CAMPAIGN_SURFACE_INFO: readonly CampaignSurfaceInfo[] = [
  {
    id: 'tip',
    label: 'Tip in the sidebar',
    description: 'A card in the sidebar footer, marked FOR YOU. Quiet — it waits until they look.',
  },
  {
    id: 'dialog',
    label: 'Dialog on next load',
    description: 'Opens over the app the next time they load it. The most interrupting of the three.',
  },
  {
    id: 'banner',
    label: 'Banner on the home screen',
    description: 'Under the composer on the home screen. Seen only by someone with no window open.',
  },
];

export function campaignSurfaceLabel(surface: string): string {
  return CAMPAIGN_SURFACE_INFO.find(info => info.id === surface)?.label ?? 'Tip in the sidebar';
}

/** One filter the composer can offer, as the server describes it. */
export interface CampaignCategory {
  id: string;
  label: string;
  /** The filter takes a day count (e.g. "no activity for N days"). */
  days: boolean;
}

/** One condition in the segment being composed. */
export interface CampaignCondition {
  category: string;
  negate: boolean;
  days?: number;
}

export interface CampaignSegment {
  match: 'any' | 'all';
  conditions: CampaignCondition[];
  /**
   * Accounts named outright. Selected in ADDITION to whatever the conditions
   * match, never intersected with them — see evaluateSegment in
   * shared/tenant-campaigns.cjs. Picking someone by hand and then having a
   * filter quietly exclude them is the one outcome this surface must not have.
   */
  account_ids?: string[];
}

export const EMPTY_SEGMENT: CampaignSegment = { match: 'all', conditions: [], account_ids: [] };

/** How many accounts a campaign may name directly. Mirrors MAX_NAMED_ACCOUNTS. */
export const MAX_NAMED_ACCOUNTS = 500;

/** The named half of a segment, tolerating a segment saved before the field existed. */
export function segmentAccountIds(segment: CampaignSegment | null | undefined): string[] {
  return Array.isArray(segment?.account_ids) ? segment.account_ids : [];
}

/** Add or remove one named recipient, preserving order and never duplicating. */
export function toggleSegmentAccount(segment: CampaignSegment, accountId: string): CampaignSegment {
  const id = String(accountId || '').trim();
  if (!id) return segment;
  const current = segmentAccountIds(segment);
  const next = current.includes(id) ? current.filter(value => value !== id) : [...current, id];
  return { ...segment, account_ids: next };
}

/** One account in a preview — the same three identity fields the tenant list shows. */
export interface CampaignPreviewAccount {
  id: string;
  email: string;
  display_name: string;
  created_at: string | null;
}

export interface CampaignPreview {
  matched_count: number;
  total_accounts: number;
  truncated: boolean;
  summary: string;
  accounts: CampaignPreviewAccount[];
}

/** A sent campaign, as the admin history lists it. */
export interface SentCampaign {
  id: string;
  title: string;
  body: string;
  surface: CampaignSurface;
  segment: CampaignSegment;
  summary: string;
  recipient_count: number;
  dismissed_count: number;
  created_by_email: string;
  created_at: string | null;
}

/** A message as its RECIPIENT receives it. No sender, no segment, no counts. */
export interface OwnerMessage {
  id: string;
  title: string;
  body: string;
  surface: CampaignSurface;
  created_at: string | null;
}

/**
 * Why the send button is disabled, or null when it is not.
 *
 * Returned as a SENTENCE rather than a boolean because every one of these is
 * something the owner has to fix, and a greyed-out button that will not say why
 * is the thing people file bugs about. The server enforces every one of these
 * again — this exists so the answer arrives before the round trip, not instead
 * of it.
 */
export function campaignBlockedReason(input: {
  title: string;
  body: string;
  segment: CampaignSegment;
  preview: CampaignPreview | null;
  previewLoading: boolean;
}): string | null {
  if (!input.title.trim()) return 'Give the message a title.';
  if (!input.body.trim()) return 'Write the message.';
  // An empty condition list is not "everyone", it is "nobody" — the same rule
  // the server's evaluateSegment enforces. Saying so here means the owner is
  // never looking at a composer that appears ready and is not.
  // A hand-picked list is a complete campaign on its own — requiring a filter
  // beside it would make "send this to these three people" impossible to
  // express. Only when BOTH are empty is there nobody to send to.
  if (input.segment.conditions.length === 0 && segmentAccountIds(input.segment).length === 0) {
    return 'Pick at least one filter, or choose who to send to.';
  }
  if (input.previewLoading || !input.preview) return 'Checking who matches…';
  if (input.preview.matched_count === 0) return 'No accounts match these filters.';
  return null;
}

/**
 * The line the confirm step shows above the button.
 *
 * Says the NUMBER and the SURFACE, because those are the two things that make a
 * broadcast irreversible in a way the owner cares about: how many people, and
 * how loudly.
 */
export function campaignConfirmSentence(count: number, surface: CampaignSurface): string {
  const people = count === 1 ? '1 account' : `${count} accounts`;
  const where = surface === 'dialog'
    ? 'as a dialog the next time they load agensis'
    : surface === 'banner'
      ? 'as a banner on their home screen'
      : 'as a tip in their sidebar';
  return `This sends the message to ${people}, ${where}.`;
}

/** Characters left in a capped field. Negative is not possible — it clamps. */
export function charactersLeft(value: string, max: number): number {
  return Math.max(0, max - value.length);
}
