import { describe, expect, it } from 'vitest';
import {
  AGENT_LAYOUT_VIEWS,
  AGENT_LAYOUT_VIEW_PREF,
  AGENTS_SPLIT_MIN_REM,
  agentDetailPlacement,
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
