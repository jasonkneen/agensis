import { describe, expect, it } from 'vitest';
import {
  AGENT_LAYOUT_VIEWS,
  AGENT_LAYOUT_VIEW_PREF,
  AGENTS_SPLIT_MIN_REM,
  agentDetailPlacement,
  agentFormBarPlacement,
  toggleAgentSelection,
} from '../../src/lib/agentsView';
import { readPreference, type PreferenceStorage } from '../../src/lib/viewPreferences';

// The Agents window's view decisions, tested where they can go wrong silently:
// a stored layout value from a build with a different set of modes, a click on
// an already-open card, and the width at which two panes stop being readable.

function storageWith(value: string): PreferenceStorage {
  return { getItem: () => value, setItem: () => {} };
}

const KEY = 'agensis.agents.layout-view:ws-1';

describe('AGENT_LAYOUT_VIEW_PREF', () => {
  it('accepts exactly the three modes', () => {
    expect([...AGENT_LAYOUT_VIEWS]).toEqual(['grid', 'network', 'both']);
    for (const view of AGENT_LAYOUT_VIEWS) {
      expect(AGENT_LAYOUT_VIEW_PREF.parse(view)).toBe(view);
      expect(AGENT_LAYOUT_VIEW_PREF.serialize(view)).toBe(view);
    }
  });

  it('rejects everything else', () => {
    for (const raw of ['list', 'map', 'BOTH', ' both', 'grid,network', '', 'null', 'undefined', '["grid"]', '{"view":"grid"}']) {
      expect(AGENT_LAYOUT_VIEW_PREF.parse(raw)).toBeNull();
    }
  });

  it('reads a stored "both" back, and falls to the default on a retired value', () => {
    // 'both' is new — a key written by this build must survive a reload…
    expect(readPreference(KEY, AGENT_LAYOUT_VIEW_PREF, 'grid', storageWith('both'))).toBe('both');
    // …and a value from a build with different modes must not blank the window.
    expect(readPreference(KEY, AGENT_LAYOUT_VIEW_PREF, 'grid', storageWith('mesh'))).toBe('grid');
  });
});

describe('toggleAgentSelection', () => {
  it('selects from nothing', () => {
    expect(toggleAgentSelection(null, 'a1')).toBe('a1');
  });

  it('retargets when a different agent is clicked', () => {
    expect(toggleAgentSelection('a1', 'a2')).toBe('a2');
  });

  it('clicking the open agent again closes it', () => {
    expect(toggleAgentSelection('a1', 'a1')).toBeNull();
  });
});

describe('agentDetailPlacement', () => {
  const threshold = AGENTS_SPLIT_MIN_REM * 16; // 672 at the browser default

  it('sits beside the grid at the threshold and above, replaces it below', () => {
    expect(agentDetailPlacement(threshold)).toBe('beside');
    expect(agentDetailPlacement(threshold + 400)).toBe('beside');
    expect(agentDetailPlacement(threshold - 1)).toBe('replace');
    expect(agentDetailPlacement(320)).toBe('replace');
  });

  it('moves with the root font size, exactly like the rem-based container query', () => {
    // 42rem is 630px at the app's 15px default UI size…
    expect(agentDetailPlacement(640, 15)).toBe('beside');
    // …and 714px when the user turns the base size up to 17.
    expect(agentDetailPlacement(700, 17)).toBe('replace');
  });

  it('falls back to a 16px rem on a garbage font size', () => {
    expect(agentDetailPlacement(700, 0)).toBe('beside');
    expect(agentDetailPlacement(600, -3)).toBe('replace');
    expect(agentDetailPlacement(600, Number.NaN)).toBe('replace');
  });

  it('keeps the normal two-pane arrangement when the width is unknowable', () => {
    expect(agentDetailPlacement(Number.NaN)).toBe('beside');
    expect(agentDetailPlacement(Number.POSITIVE_INFINITY)).toBe('beside');
  });
});

describe('agentFormBarPlacement', () => {
  // A long form: 1200px of content in a 400px pane, so 800px of travel.
  const long = (scrollTop: number) => agentFormBarPlacement(scrollTop, 1200, 400);

  it('keeps the bar at the top for the first half of the travel', () => {
    expect(long(0)).toBe('top');
    expect(long(1)).toBe('top');
    expect(long(399)).toBe('top');
  });

  it('hands over to the bottom bar at the halfway point and past it', () => {
    expect(long(400)).toBe('bottom');
    expect(long(401)).toBe('bottom');
    expect(long(700)).toBe('bottom');
  });

  it('is on the bottom bar at the very end of the scroll', () => {
    expect(long(800)).toBe('bottom');
    // Overscroll (rubber-banding, sub-pixel rounding) must not flip it back.
    expect(long(812)).toBe('bottom');
  });

  it('KEEPS THE TOP BAR when the pane has nothing to scroll', () => {
    // The short-window case: content fits, so there is no halfway to reach and
    // hiding the top bar would leave the form with no Save button at all.
    expect(agentFormBarPlacement(0, 400, 400)).toBe('top');
    expect(agentFormBarPlacement(0, 180, 400)).toBe('top');
    // Even if a browser hands back a stale scrollTop for an unscrollable pane.
    expect(agentFormBarPlacement(120, 400, 400)).toBe('top');
  });

  it('takes the safe answer on unmeasurable geometry', () => {
    expect(agentFormBarPlacement(Number.NaN, 1200, 400)).toBe('top');
    expect(agentFormBarPlacement(0, Number.NaN, 400)).toBe('top');
    expect(agentFormBarPlacement(0, 1200, Number.NaN)).toBe('top');
    // A negative scrollTop is iOS overscroll at the top of the pane.
    expect(agentFormBarPlacement(-40, 1200, 400)).toBe('top');
  });

  it('measures halfway against the scrollable distance, not the content height', () => {
    // 1200px of content, but only 200px of travel in a 1000px-tall pane: the
    // swap lands at 100px, not at 600px.
    expect(agentFormBarPlacement(99, 1200, 1000)).toBe('top');
    expect(agentFormBarPlacement(100, 1200, 1000)).toBe('bottom');
  });
});
