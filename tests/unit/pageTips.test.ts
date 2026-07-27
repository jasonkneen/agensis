// Guards the two decisions behind the sidebar-footer panel (src/lib/pageTips.ts):
// which surface a windowed desktop is "on", and whether that space shows the
// onboarding checklist or a tip.
//
// The priority rule is the one worth pinning: a new user with an unfinished
// setup step must never be shown advice about the canvas instead. The dismissal
// rule is the other: a tip the user closed must not come back, and closing one
// must reveal the next rather than emptying the space.

import { describe, it, expect } from 'vitest';
import {
  ALL_TIP_IDS,
  PAGE_TIPS,
  TIP_SURFACE_LABEL,
  nextTipFor,
  resolveGetStartedSlot,
  tipSurfaceFor,
  tipsForSurface,
  type TipSurface,
} from '../../src/lib/pageTips';
import type { FloatingWindowType } from '../../src/types';

const ALL_SURFACES: TipSurface[] = [
  'canvas', 'channel', 'dm', 'document', 'agents', 'inbox', 'tasks',
  'activity', 'memory', 'skills', 'users', 'schedules', 'tenants',
];

describe('tipSurfaceFor', () => {
  it('treats nothing-focused as the canvas', () => {
    expect(tipSurfaceFor({})).toBe('canvas');
    expect(tipSurfaceFor({ focusedWindowType: null })).toBe('canvas');
  });

  it('splits a chat window into channel and DM', () => {
    expect(tipSurfaceFor({ focusedWindowType: 'chat' })).toBe('channel');
    expect(tipSurfaceFor({ focusedWindowType: 'chat', isDirectMessage: false })).toBe('channel');
    expect(tipSurfaceFor({ focusedWindowType: 'chat', isDirectMessage: true })).toBe('dm');
  });

  it('ignores the DM hint for every other window type', () => {
    expect(tipSurfaceFor({ focusedWindowType: 'tasks', isDirectMessage: true })).toBe('tasks');
  });

  it('maps every window type to a surface', () => {
    const types: FloatingWindowType[] = [
      'chat', 'document', 'memory', 'skills', 'tasks', 'activity', 'agents', 'users', 'schedules', 'inbox',
    ];
    for (const type of types) {
      const surface = tipSurfaceFor({ focusedWindowType: type });
      expect(ALL_SURFACES, `${type} resolved to ${surface}`).toContain(surface);
      // Only 'chat' is allowed to fall through to the canvas default's neighbours;
      // an unmapped type would silently answer 'canvas' for a real window.
      if (type !== 'chat') expect(surface).not.toBe('canvas');
    }
  });

  it('lets the Tenants overlay outrank the window behind it', () => {
    expect(tipSurfaceFor({ overlay: 'tenants', focusedWindowType: 'agents' })).toBe('tenants');
    expect(tipSurfaceFor({ overlay: null, focusedWindowType: 'agents' })).toBe('agents');
  });
});

describe('tips content', () => {
  it('has at least two tips for every surface', () => {
    for (const surface of ALL_SURFACES) {
      expect(tipsForSurface(surface).length, surface).toBeGreaterThanOrEqual(2);
    }
  });

  it('has a label for every surface', () => {
    for (const surface of ALL_SURFACES) {
      expect(TIP_SURFACE_LABEL[surface], surface).toBeTruthy();
    }
  });

  it('has unique ids, which are the dismissal keys', () => {
    expect(new Set(ALL_TIP_IDS).size).toBe(PAGE_TIPS.length);
  });

  it('declares no surface outside the known set', () => {
    for (const tip of PAGE_TIPS) expect(ALL_SURFACES, tip.id).toContain(tip.surface);
  });

  it('carries no emoji — an absolute rule in this repo', () => {
    // Covers the pictographic + dingbat + symbol blocks, plus the variation
    // selector (kept out of the class: it combines, which eslint rightly flags).
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}]|\uFE0F/u;
    for (const tip of PAGE_TIPS) {
      expect(emoji.test(tip.title), `${tip.id} title`).toBe(false);
      expect(emoji.test(tip.body), `${tip.id} body`).toBe(false);
    }
  });

  it('keeps each tip short enough for the sidebar footer', () => {
    for (const tip of PAGE_TIPS) {
      expect(tip.title.length, `${tip.id} title`).toBeLessThanOrEqual(60);
      expect(tip.body.length, `${tip.id} body`).toBeLessThanOrEqual(260);
    }
  });
});

describe('nextTipFor', () => {
  it('returns the first undismissed tip in authored order', () => {
    const [first, second] = tipsForSurface('canvas');
    expect(nextTipFor('canvas', [])?.id).toBe(first.id);
    expect(nextTipFor('canvas', [first.id])?.id).toBe(second.id);
  });

  it('returns null once every tip on the surface is dismissed', () => {
    const all = tipsForSurface('memory').map(t => t.id);
    expect(nextTipFor('memory', all)).toBeNull();
  });

  it('does not let a dismissal on one surface hide another surface tip', () => {
    const canvas = tipsForSurface('canvas').map(t => t.id);
    expect(nextTipFor('tasks', canvas)?.surface).toBe('tasks');
  });

  it('accepts a Set as readily as an array', () => {
    const first = tipsForSurface('inbox')[0];
    expect(nextTipFor('inbox', new Set([first.id]))?.id).not.toBe(first.id);
  });
});

describe('resolveGetStartedSlot', () => {
  const base = { surface: 'canvas' as TipSurface, dismissedTipIds: [] as string[] };

  it('shows the checklist while any onboarding step is outstanding', () => {
    expect(resolveGetStartedSlot({ ...base, onboardingRemaining: 4, checklistDismissed: false }))
      .toEqual({ kind: 'checklist' });
  });

  it('still shows the checklist when onboarding is only PARTLY done', () => {
    // The case the rule exists for: a user who started setting up and stopped
    // must not have the last step covered by advice about the canvas.
    expect(resolveGetStartedSlot({ ...base, onboardingRemaining: 1, checklistDismissed: false }))
      .toEqual({ kind: 'checklist' });
  });

  it('hands the space to tips once onboarding is complete', () => {
    const slot = resolveGetStartedSlot({ ...base, onboardingRemaining: 0, checklistDismissed: false });
    expect(slot.kind).toBe('tip');
    if (slot.kind === 'tip') expect(slot.tip.surface).toBe('canvas');
  });

  it('hands the space to tips when the user closed the checklist unfinished', () => {
    // Dismissing the checklist says "stop tracking my setup", not "never tell me
    // anything" — tips have their own per-tip dismissal for that.
    const slot = resolveGetStartedSlot({ ...base, onboardingRemaining: 3, checklistDismissed: true });
    expect(slot.kind).toBe('tip');
  });

  it('follows the surface it is given', () => {
    const slot = resolveGetStartedSlot({
      surface: 'agents', dismissedTipIds: [], onboardingRemaining: 0, checklistDismissed: true,
    });
    if (slot.kind !== 'tip') throw new Error('expected a tip');
    expect(slot.tip.surface).toBe('agents');
  });

  it('advances to the next tip as they are dismissed, then empties', () => {
    const surface: TipSurface = 'skills';
    const ids = tipsForSurface(surface).map(t => t.id);
    const dismissed: string[] = [];
    for (const expected of ids) {
      const slot = resolveGetStartedSlot({
        surface, dismissedTipIds: dismissed, onboardingRemaining: 0, checklistDismissed: false,
      });
      if (slot.kind !== 'tip') throw new Error(`expected a tip, got ${slot.kind}`);
      expect(slot.tip.id).toBe(expected);
      dismissed.push(slot.tip.id);
    }
    expect(resolveGetStartedSlot({
      surface, dismissedTipIds: dismissed, onboardingRemaining: 0, checklistDismissed: false,
    })).toEqual({ kind: 'none' });
  });

  it('renders nothing rather than the checklist when onboarding is done and tips are exhausted', () => {
    const dismissed = ALL_TIP_IDS.slice();
    expect(resolveGetStartedSlot({
      surface: 'dm', dismissedTipIds: dismissed, onboardingRemaining: 0, checklistDismissed: false,
    })).toEqual({ kind: 'none' });
  });
});
