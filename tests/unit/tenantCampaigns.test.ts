// The browser half of owner broadcasts (src/lib/tenantCampaigns.ts).
//
// There is deliberately NO segment matcher here to test: who receives a message
// is decided once, on the server, in shared/tenant-campaigns.cjs. What this file
// pins is the two things the browser does own, both of which stand between an
// operator and an accidental broadcast:
//
//   * campaignBlockedReason — WHY the send button is disabled. An empty filter
//     list must read as "pick a filter", never as ready-to-send, because the
//     server's rule is that no filters means nobody and a composer that looks
//     armed while it is not is how people press things twice.
//   * campaignConfirmSentence — the number and the surface, in words, in the
//     confirm dialog.
//
// Plus the sidebar-slot priority, which moved: an owner message now outranks
// both the onboarding checklist and page tips.

import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_SURFACES,
  CAMPAIGN_SURFACE_INFO,
  EMPTY_SEGMENT,
  MAX_BODY_LENGTH,
  MAX_TITLE_LENGTH,
  campaignBlockedReason,
  campaignConfirmSentence,
  campaignSurfaceLabel,
  charactersLeft,
  type CampaignPreview,
  type CampaignSegment,
} from '../../src/lib/tenantCampaigns';
import { resolveGetStartedSlot } from '../../src/lib/pageTips';

const ONE_FILTER: CampaignSegment = { match: 'all', conditions: [{ category: 'no_agents', negate: false }] };

function preview(matched: number): CampaignPreview {
  return {
    matched_count: matched,
    total_accounts: 40,
    truncated: false,
    summary: 'has no agents',
    accounts: [],
  };
}

const READY = {
  title: 'Try huddles',
  body: 'Press the huddle button in any channel.',
  segment: ONE_FILTER,
  preview: preview(12),
  previewLoading: false,
};

describe('campaignBlockedReason', () => {
  it('lets a fully composed message through', () => {
    expect(campaignBlockedReason(READY)).toBeNull();
  });

  it('blocks an EMPTY filter list — no filters is nobody, not everybody', () => {
    // The rule that matters. If this ever read as sendable, the composer would
    // look armed while the server was about to refuse — or worse, if the
    // server's rule were ever inverted, would arm a send to every account.
    const reason = campaignBlockedReason({ ...READY, segment: EMPTY_SEGMENT, preview: null });
    expect(reason).toBe('Pick at least one filter.');
  });

  it('blocks a segment that matched nobody, and says so', () => {
    expect(campaignBlockedReason({ ...READY, preview: preview(0) })).toBe('No accounts match these filters.');
  });

  it('blocks while the count is still being fetched', () => {
    // The count is what the owner confirms; sending against a stale or absent
    // one is exactly the case the server answers 409 for.
    expect(campaignBlockedReason({ ...READY, previewLoading: true })).toBe('Checking who matches…');
    expect(campaignBlockedReason({ ...READY, preview: null })).toBe('Checking who matches…');
  });

  it('blocks an empty title or body, including whitespace-only', () => {
    expect(campaignBlockedReason({ ...READY, title: '' })).toBe('Give the message a title.');
    expect(campaignBlockedReason({ ...READY, title: '   ' })).toBe('Give the message a title.');
    expect(campaignBlockedReason({ ...READY, body: '' })).toBe('Write the message.');
    expect(campaignBlockedReason({ ...READY, body: '\n ' })).toBe('Write the message.');
  });

  it('reports the FIRST thing wrong, so fixing it reveals the next', () => {
    const nothing = campaignBlockedReason({
      title: '', body: '', segment: EMPTY_SEGMENT, preview: null, previewLoading: false,
    });
    expect(nothing).toBe('Give the message a title.');
  });
});

describe('campaignConfirmSentence', () => {
  it('states the count and the surface', () => {
    expect(campaignConfirmSentence(38, 'tip')).toBe('This sends the message to 38 accounts, as a tip in their sidebar.');
    expect(campaignConfirmSentence(1, 'dialog'))
      .toBe('This sends the message to 1 account, as a dialog the next time they load agensis.');
    expect(campaignConfirmSentence(4, 'banner')).toBe('This sends the message to 4 accounts, as a banner on their home screen.');
  });

  it('never says "0 accounts" as if that were a send', () => {
    // Not because the sentence is wrong, but because the button is disabled long
    // before it renders — this pins that the two agree.
    expect(campaignBlockedReason({ ...READY, preview: preview(0) })).not.toBeNull();
  });
});

describe('the surface catalogue', () => {
  it('describes every surface the server accepts, and no others', () => {
    expect(CAMPAIGN_SURFACE_INFO.map(info => info.id)).toEqual([...CAMPAIGN_SURFACES]);
  });

  it('falls back to the QUIETEST surface for an unknown value', () => {
    // A row written by a newer build must render somewhere, and a tip is the
    // least interrupting of the three.
    expect(campaignSurfaceLabel('popup')).toBe('Tip in the sidebar');
    expect(campaignSurfaceLabel('dialog')).toBe('Dialog on next load');
  });

  it('every surface says what the RECIPIENT sees', () => {
    for (const info of CAMPAIGN_SURFACE_INFO) {
      expect(info.description.length).toBeGreaterThan(20);
      expect(info.label.length).toBeGreaterThan(0);
    }
  });
});

describe('charactersLeft', () => {
  it('counts down and clamps at zero rather than going negative', () => {
    expect(charactersLeft('abc', 10)).toBe(7);
    expect(charactersLeft('x'.repeat(200), MAX_TITLE_LENGTH)).toBe(0);
    expect(charactersLeft('', MAX_BODY_LENGTH)).toBe(MAX_BODY_LENGTH);
  });
});

describe('the sidebar slot, now that an owner message can claim it', () => {
  const base = {
    onboardingRemaining: 0,
    checklistDismissed: false,
    surface: 'canvas' as const,
    dismissedTipIds: [] as string[],
  };

  it('an owner message outranks an UNFINISHED checklist', () => {
    // The argued ordering. A broadcast is segmented on behaviour — "has no
    // agents", "never started a huddle" — which describes exactly the accounts
    // that still have a checklist. Ranking it below would mean the message
    // reaches everyone except the people it was aimed at.
    expect(resolveGetStartedSlot({ ...base, hasOwnerMessage: true, onboardingRemaining: 3 }))
      .toEqual({ kind: 'owner-message' });
  });

  it('an owner message outranks a tip', () => {
    expect(resolveGetStartedSlot({ ...base, hasOwnerMessage: true })).toEqual({ kind: 'owner-message' });
  });

  it('the checklist comes back the moment the message is dismissed', () => {
    // Nothing is lost by putting the message first: the checklist does not
    // expire, and dismissal is one click.
    expect(resolveGetStartedSlot({ ...base, hasOwnerMessage: false, onboardingRemaining: 3 }))
      .toEqual({ kind: 'checklist' });
  });

  it('without a message the old priority is exactly unchanged', () => {
    expect(resolveGetStartedSlot({ ...base, onboardingRemaining: 2 })).toEqual({ kind: 'checklist' });
    const tip = resolveGetStartedSlot({ ...base, onboardingRemaining: 0 });
    expect(tip.kind).toBe('tip');
    expect(resolveGetStartedSlot({ ...base, onboardingRemaining: 2, checklistDismissed: true }).kind).toBe('tip');
  });
});
