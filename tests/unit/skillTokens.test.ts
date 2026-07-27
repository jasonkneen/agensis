import { describe, expect, it } from 'vitest';
import {
  addSkillToken,
  applySkillFieldInput,
  applySkillFieldKey,
  buildSkillSuggestions,
  nextActiveIndex,
  parseSkillTokens,
  removeSkillTokenAt,
  serializeSkillTokens,
  skillMenuOptions,
  type SkillFieldState,
  type SkillSuggestion,
} from '../../src/lib/skillTokens';
import type { SkillEntry } from '../../src/lib/skillsView';

const suggestions: SkillSuggestion[] = [
  { value: 'deploy-targets', label: 'deploy-targets', detail: '2 agents' },
  { value: 'sandbox-provider-box', label: 'sandbox-provider-box', detail: 'In agensis' },
  { value: 'aws-sandbox', label: 'aws-sandbox', detail: 'In agensis' },
  { value: 'codex-user-skills', label: 'Codex user skills', detail: 'Library · 12' },
];

function state(partial: Partial<SkillFieldState> = {}): SkillFieldState {
  return { tokens: [], draft: '', activeIndex: -1, open: false, ...partial };
}

describe('parsing the form value', () => {
  it('survives a messy comma string', () => {
    expect(parseSkillTokens('  deploy-targets ,, aws-sandbox,  ,browse  '))
      .toEqual(['deploy-targets', 'aws-sandbox', 'browse']);
  });

  it('drops an exact repeat rather than drawing the same chip twice', () => {
    expect(parseSkillTokens('a, b, a')).toEqual(['a', 'b']);
  });

  it('treats newlines as separators, so a pasted list is chips not one long token', () => {
    expect(parseSkillTokens('a\nb, c')).toEqual(['a', 'b', 'c']);
  });

  it('is empty for nothing at all', () => {
    expect(parseSkillTokens('')).toEqual([]);
    expect(parseSkillTokens(null)).toEqual([]);
    expect(parseSkillTokens(undefined)).toEqual([]);
    expect(parseSkillTokens('  ,  , ')).toEqual([]);
  });

  it('round-trips: serialize then parse is the same token list', () => {
    const tokens = parseSkillTokens('deploy-targets,aws-sandbox');
    expect(serializeSkillTokens(tokens)).toBe('deploy-targets, aws-sandbox');
    expect(parseSkillTokens(serializeSkillTokens(tokens))).toEqual(tokens);
  });
});

describe('adding and removing', () => {
  it('trims, and ignores an empty token', () => {
    expect(addSkillToken([], '  browse  ')).toEqual(['browse']);
    const tokens = ['browse'];
    expect(addSkillToken(tokens, '   ')).toBe(tokens);
  });

  it('refuses a duplicate under any casing, and returns the same array', () => {
    const tokens = ['Browse'];
    expect(addSkillToken(tokens, 'browse')).toBe(tokens);
    expect(addSkillToken(tokens, 'BROWSE')).toBe(tokens);
  });

  it('removes by index, and ignores an index that is not there', () => {
    expect(removeSkillTokenAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
    const tokens = ['a'];
    expect(removeSkillTokenAt(tokens, 4)).toBe(tokens);
    expect(removeSkillTokenAt(tokens, -1)).toBe(tokens);
  });
});

describe('what the menu offers', () => {
  it('shows everything known when nothing has been typed', () => {
    const options = skillMenuOptions(suggestions, '', []);
    expect(options.map(o => o.value)).toEqual([
      'deploy-targets', 'sandbox-provider-box', 'aws-sandbox', 'codex-user-skills',
    ]);
    expect(options.every(o => o.kind === 'suggestion')).toBe(true);
  });

  it('ranks a prefix match above a substring one, and the half-typed name last', () => {
    const options = skillMenuOptions(suggestions, 'sand', []);
    expect(options.map(o => o.value)).toEqual(['sandbox-provider-box', 'aws-sandbox', 'sand']);
    expect(options[2].kind).toBe('custom');
  });

  it('matches the label as well as the value', () => {
    expect(skillMenuOptions(suggestions, 'Codex user', []).map(o => o.value))
      .toEqual(['codex-user-skills', 'Codex user']);
  });

  it('never offers a skill that is already a chip', () => {
    const options = skillMenuOptions(suggestions, '', ['deploy-targets']);
    expect(options.map(o => o.value)).not.toContain('deploy-targets');
  });

  it('offers a free-typed name nothing knows about — the only row, so Enter takes it', () => {
    const options = skillMenuOptions(suggestions, 'brand-new-skill', []);
    expect(options).toEqual([
      { kind: 'custom', value: 'brand-new-skill', label: 'brand-new-skill', detail: '' },
    ]);
  });

  it('does not offer to add a name that is already an exact suggestion', () => {
    const options = skillMenuOptions(suggestions, 'aws-sandbox', []);
    expect(options.some(o => o.kind === 'custom')).toBe(false);
    expect(options[0].value).toBe('aws-sandbox');
  });

  it('does not offer to add a name that is already a chip', () => {
    expect(skillMenuOptions(suggestions, 'aws-sandbox', ['aws-sandbox'])).toEqual([]);
  });

  it('caps the suggestion rows but never hides the custom one', () => {
    const many: SkillSuggestion[] = Array.from({ length: 30 }, (_, i) => ({
      value: `skill-${i}`, label: `skill-${i}`, detail: '',
    }));
    const options = skillMenuOptions(many, 'kill-1', [], 3);
    expect(options).toHaveLength(4);
    expect(options.filter(o => o.kind === 'suggestion')).toHaveLength(3);
    expect(options[3].kind).toBe('custom');
  });
});

describe('where suggestions come from', () => {
  const entries: SkillEntry[] = [
    { name: 'zeta-carried', agents: [{}, {}] as never, origin: 'agent', advertised: true },
    { name: 'alpha-carried', agents: [{}] as never, origin: 'agent', advertised: false },
    { name: 'shipped-skill', agents: [], origin: 'catalog', advertised: false },
  ];
  const capabilities = {
    skills: [
      { id: 'codex-user-skills', label: 'Codex user skills', type: 'skills', path: '/x', available: true, count: 12 },
      { id: 'gone', label: 'Gone', type: 'skills', path: '/y', available: false, count: 0 },
      { id: 'alpha-carried', label: 'Alpha', type: 'skills', path: '/z', available: true, count: 1 },
    ],
  } as never;

  it('unions carried skills, the agensis catalog, and the host libraries', () => {
    const built = buildSkillSuggestions(entries, capabilities);
    expect(built.map(s => s.value)).toEqual([
      'alpha-carried', 'zeta-carried', 'shipped-skill', 'codex-user-skills',
    ]);
  });

  it('says where each one came from, and counts the agents that carry it', () => {
    const built = buildSkillSuggestions(entries, capabilities);
    expect(built.find(s => s.value === 'zeta-carried')?.detail).toBe('2 agents');
    expect(built.find(s => s.value === 'alpha-carried')?.detail).toBe('1 agent');
    expect(built.find(s => s.value === 'shipped-skill')?.detail).toBe('In agensis');
    expect(built.find(s => s.value === 'codex-user-skills')?.detail).toBe('Library · 12');
  });

  it('leaves out an unavailable library, and never lists the same name twice', () => {
    const built = buildSkillSuggestions(entries, capabilities);
    expect(built.map(s => s.value)).not.toContain('gone');
    expect(built.filter(s => s.value === 'alpha-carried')).toHaveLength(1);
  });

  it('works with no capabilities at all — the agents alone are enough', () => {
    expect(buildSkillSuggestions(entries, null).map(s => s.value))
      .toEqual(['alpha-carried', 'zeta-carried', 'shipped-skill']);
  });
});

describe('the keyboard', () => {
  it('Enter commits the highlighted row', () => {
    const options = skillMenuOptions(suggestions, 'sand', []);
    const result = applySkillFieldKey(state({ draft: 'sand', open: true, activeIndex: 1 }), 'Enter', options);
    expect(result.handled).toBe(true);
    expect(result.state.tokens).toEqual(['aws-sandbox']);
    expect(result.state.draft).toBe('');
    expect(result.state.open).toBe(false);
  });

  it('Enter with nothing highlighted commits the best match, not the half-typed name', () => {
    const options = skillMenuOptions(suggestions, 'deploy', []);
    const result = applySkillFieldKey(state({ draft: 'deploy', open: true }), 'Enter', options);
    expect(result.state.tokens).toEqual(['deploy-targets']);
  });

  it('the half-typed name is still reachable — it is the last row', () => {
    const options = skillMenuOptions(suggestions, 'deploy', []);
    const result = applySkillFieldKey(
      state({ draft: 'deploy', open: true, activeIndex: options.length - 1 }), 'Enter', options,
    );
    expect(result.state.tokens).toEqual(['deploy']);
  });

  it('Enter commits a name nothing knows — this field is how a new skill arrives', () => {
    const draft = 'my-private-skill';
    const options = skillMenuOptions(suggestions, draft, []);
    const result = applySkillFieldKey(state({ draft, open: true }), 'Enter', options);
    expect(result.state.tokens).toEqual(['my-private-skill']);
  });

  it('a comma commits too, the way a token field always has', () => {
    const result = applySkillFieldKey(state({ draft: 'browse' }), ',', []);
    expect(result.handled).toBe(true);
    expect(result.state.tokens).toEqual(['browse']);
  });

  it('Enter on an empty draft with no menu does nothing', () => {
    const before = state();
    const result = applySkillFieldKey(before, 'Enter', []);
    expect(result.state).toBe(before);
    expect(result.handled).toBe(false);
  });

  it('Backspace on an empty input removes the last chip', () => {
    const result = applySkillFieldKey(state({ tokens: ['a', 'b'] }), 'Backspace', []);
    expect(result.handled).toBe(true);
    expect(result.state.tokens).toEqual(['a']);
  });

  it('Backspace with text in the input deletes a character instead — it is not ours', () => {
    const before = state({ tokens: ['a'], draft: 'br' });
    const result = applySkillFieldKey(before, 'Backspace', []);
    expect(result.handled).toBe(false);
    expect(result.state).toBe(before);
  });

  it('Backspace with no chips at all is not ours either', () => {
    expect(applySkillFieldKey(state(), 'Backspace', []).handled).toBe(false);
  });

  it('Escape closes the menu, and once it is closed the key belongs to the dialog', () => {
    const open = applySkillFieldKey(state({ open: true, activeIndex: 2 }), 'Escape', []);
    expect(open.handled).toBe(true);
    expect(open.state.open).toBe(false);
    expect(open.state.activeIndex).toBe(-1);
    expect(applySkillFieldKey(state(), 'Escape', []).handled).toBe(false);
  });

  it('arrows open the menu, then move through it and wrap', () => {
    const options = skillMenuOptions(suggestions, '', []);
    const opened = applySkillFieldKey(state(), 'ArrowDown', options);
    expect(opened.state.open).toBe(true);
    expect(opened.state.activeIndex).toBe(0);

    const down = applySkillFieldKey(opened.state, 'ArrowDown', options);
    expect(down.state.activeIndex).toBe(1);

    const up = applySkillFieldKey(state({ open: true, activeIndex: 0 }), 'ArrowUp', options);
    expect(up.state.activeIndex).toBe(options.length - 1);
  });

  it('leaves every other key alone', () => {
    const before = state({ draft: 'x' });
    expect(applySkillFieldKey(before, 'a', []).handled).toBe(false);
    expect(applySkillFieldKey(before, 'Tab', []).handled).toBe(false);
  });

  it('wraps in both directions and reports no row for an empty menu', () => {
    expect(nextActiveIndex(2, 1, 3)).toBe(0);
    expect(nextActiveIndex(0, -1, 3)).toBe(2);
    expect(nextActiveIndex(-1, 1, 3)).toBe(0);
    expect(nextActiveIndex(-1, -1, 3)).toBe(2);
    expect(nextActiveIndex(0, 1, 0)).toBe(-1);
  });
});

describe('typing and pasting', () => {
  it('keeps plain typing in the draft and opens the menu', () => {
    const next = applySkillFieldInput(state(), 'bro');
    expect(next.draft).toBe('bro');
    expect(next.open).toBe(true);
    expect(next.tokens).toEqual([]);
  });

  it('turns a pasted list into chips, keeping the unterminated tail as the draft', () => {
    const next = applySkillFieldInput(state(), 'a, b, c');
    expect(next.tokens).toEqual(['a', 'b']);
    expect(next.draft).toBe(' c');
  });

  it('a trailing comma leaves nothing behind', () => {
    const next = applySkillFieldInput(state(), 'a, b,');
    expect(next.tokens).toEqual(['a', 'b']);
    expect(next.draft).toBe('');
  });

  it('a pasted list cannot smuggle in a duplicate', () => {
    const next = applySkillFieldInput(state({ tokens: ['a'] }), 'A, b,');
    expect(next.tokens).toEqual(['a', 'b']);
  });
});

describe('the sparse-diff property', () => {
  // The Agents edit form sends ONLY the fields that changed (a deliberate fix:
  // saving any MCP agent used to rewrite run_mode). It decides that by
  // comparing `splitList(form.skills)` against the same call on the value the
  // form was seeded with. So the chip field is safe iff a value that has been
  // through it, untouched, still splits to the identical array.
  const splitList = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);

  it('a value that goes through the chips untouched still splits identically', () => {
    for (const seed of ['deploy-targets, aws-sandbox', 'browse', '', 'a, b, c']) {
      const throughChips = serializeSkillTokens(parseSkillTokens(seed));
      expect(splitList(throughChips)).toEqual(splitList(seed));
    }
  });

  it('a real edit produces exactly the array the diff will send', () => {
    const seed = 'deploy-targets, aws-sandbox';
    const after = serializeSkillTokens(addSkillToken(parseSkillTokens(seed), 'browse'));
    expect(splitList(after)).toEqual(['deploy-targets', 'aws-sandbox', 'browse']);
    expect(JSON.stringify(splitList(after)) === JSON.stringify(splitList(seed))).toBe(false);
  });

  it('a no-op edit — re-adding a skill already there — leaves the value identical', () => {
    const seed = 'deploy-targets, aws-sandbox';
    const tokens = parseSkillTokens(seed);
    expect(addSkillToken(tokens, 'Deploy-Targets')).toBe(tokens);
    expect(JSON.stringify(splitList(serializeSkillTokens(tokens)))).toBe(JSON.stringify(splitList(seed)));
  });
});
