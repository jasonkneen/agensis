import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

import {
  SKILL_BODY_MAX_BYTES,
  SKILL_NAME_MAX,
  SKILL_SUMMARY_MAX,
  SKILL_TITLE_MAX,
  describeSkillProvenance,
  emptySkillDraft,
  problemFor,
  skillBodyBytes,
  skillToDraft,
  slugifySkillName,
  validateSkillDraft,
  type WorkspaceSkill,
} from '../../src/lib/workspaceSkills';
import { buildSkillEntries, type StoredSkillRef } from '../../src/lib/skillsView';
import { buildSkillSuggestions, parseSkillTokens, unresolvedSkillTokens } from '../../src/lib/skillTokens';
import type { AgentConnection, WorkspaceAgent } from '../../src/types';

// ---------------------------------------------------------------------------
// The app-side skill store, frontend half.
//
// Two things are being pinned here, and only the second is ordinary form logic:
//
//   1. THE MIRROR IS FAITHFUL. src/lib/workspaceSkills.ts restates constants and
//      a slugifier that shared/workspaceSkills.cjs owns. The frontend cannot
//      import the .cjs (it would pull a CommonJS server module into the bundle),
//      so the copies are asserted equal against the real module here — the only
//      place both can be loaded at once. A drift makes the form promise a
//      lookup key the store will not use.
//   2. A DANGLING SKILL NAME IS VISIBLE. A template's `skills` array is a list of
//      names, and a name resolves to nothing on its own; unresolvedSkillTokens is
//      what turns that into something a person sees before they save.
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);
const server = require_('../../shared/workspaceSkills.cjs');

function agent(overrides: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id: 'a1',
    name: 'Ana',
    handle: 'ana',
    run_mode: 'daemon',
    skills: [],
    enabled: true,
    ...overrides,
  } as WorkspaceAgent;
}

function connection(skills: string[], agentId = 'a1'): AgentConnection {
  return { agent_id: agentId, handle: 'ana', capabilities: { skills } } as unknown as AgentConnection;
}

function stored(name: string, id = 's1', summary = ''): StoredSkillRef {
  return { id, name, summary };
}

describe('the frontend mirror matches the validator it mirrors', () => {
  it('carries the same caps', () => {
    expect(SKILL_NAME_MAX).toBe(server.MAX_NAME);
    expect(SKILL_TITLE_MAX).toBe(server.MAX_TITLE);
    expect(SKILL_SUMMARY_MAX).toBe(server.MAX_SUMMARY);
    expect(SKILL_BODY_MAX_BYTES).toBe(server.MAX_BODY_BYTES);
  });

  it('slugifies identically — the name preview is a promise about a lookup key', () => {
    const inputs = [
      'Security Review', '  Hello--World  ', 'ALL CAPS', 'trailing---', '???', 'a',
      'x'.repeat(200), 'Mixed 123 Case', 'dots.and_underscores', '',
      // The case the trailing-dash trim exists for, and the only one that
      // reaches it: the 64-char SLICE lands on a hyphen, so a slugifier that
      // trims only before slicing emits a name ending in '-'. Without this input
      // the two implementations could disagree here and every other case would
      // still match.
      `${'a'.repeat(63)} b`,
    ];
    for (const input of inputs) {
      expect(slugifySkillName(input)).toBe(server.slugifySkillName(input));
    }
  });
});

describe('validateSkillDraft', () => {
  it('accepts a complete draft', () => {
    expect(validateSkillDraft({ title: 'Security Review', summary: 'One line.', body: 'Do it.' })).toEqual([]);
  });

  it('requires a title and a body, naming each field', () => {
    const problems = validateSkillDraft({ title: '', summary: '', body: '' });
    expect(problemFor(problems, 'title')).toMatch(/title/i);
    expect(problemFor(problems, 'body')).toMatch(/procedure|body|name/i);
  });

  it('refuses a title that slugifies to nothing', () => {
    // The server would answer "name could not be derived from the title"; the
    // form has to say the same thing before the round trip.
    expect(problemFor(validateSkillDraft({ title: '///', summary: '', body: 'x' }), 'title')).toBeTruthy();
  });

  it('catches a duplicate name case-insensitively', () => {
    const problems = validateSkillDraft({ title: 'Security Review', summary: '', body: 'x' }, ['SECURITY-REVIEW']);
    expect(problemFor(problems, 'title')).toMatch(/already exists/i);
  });

  it('measures the body cap in BYTES, not characters', () => {
    // 40k two-byte characters is 80 KB — under the cap by `.length`, over it by
    // bytes. Getting this wrong is how a form accepts a body the store truncates.
    const body = 'é'.repeat(40_000);
    expect(body.length).toBeLessThan(SKILL_BODY_MAX_BYTES);
    expect(skillBodyBytes(body)).toBeGreaterThan(SKILL_BODY_MAX_BYTES);
    expect(problemFor(validateSkillDraft({ title: 'Big', summary: '', body }), 'body')).toMatch(/64 KB/);
  });

  it('agrees with the server on the same draft', () => {
    // Both directions, because the mirror must not refuse what the store accepts.
    const good = { title: 'Security Review', summary: 'x', body: 'y' };
    expect(validateSkillDraft(good)).toEqual([]);
    expect(server.normalizeWorkspaceSkill(good).ok).toBe(true);

    const bad = { title: 'Named', summary: '', body: '  ' };
    expect(validateSkillDraft(bad).length).toBeGreaterThan(0);
    expect(server.normalizeWorkspaceSkill(bad).ok).toBe(false);
  });
});

describe('draft helpers', () => {
  it('an edit draft carries the prose and never the name', () => {
    const skill = {
      id: 's1', workspace_id: 'w', name: 'security-review', title: 'T', summary: 'S', body: 'B',
      revision: 3, source: 'authored', origin: {}, created_by: null,
    } satisfies WorkspaceSkill;
    const draft = skillToDraft(skill);
    expect(draft).toEqual({ title: 'T', summary: 'S', body: 'B' });
    // Renaming would break every reference at once, so `name` is not in a draft
    // at all rather than being present and ignored.
    expect('name' in draft).toBe(false);
  });

  it('an empty draft has every field a form binds to', () => {
    expect(Object.keys(emptySkillDraft()).sort()).toEqual(['body', 'summary', 'title']);
  });

  it('describes provenance from a closed set', () => {
    expect(describeSkillProvenance('suggested')).toMatch(/conversation/i);
    expect(describeSkillProvenance('imported')).toMatch(/workspace/i);
    expect(describeSkillProvenance('anything-else')).toBe(describeSkillProvenance('authored'));
  });
});

describe('buildSkillEntries with a workspace store', () => {
  it('gives a stored skill nobody carries its own row', () => {
    const entries = buildSkillEntries([], [], [], [stored('security-review', 's1', 'SUM')]);
    const entry = entries.find(e => e.name === 'security-review');
    expect(entry).toBeDefined();
    expect(entry!.origin).toBe('workspace');
    expect(entry!.stored).toBe(true);
    expect(entry!.storedId).toBe('s1');
    expect(entry!.summary).toBe('SUM');
    expect(entry!.agents).toEqual([]);
  });

  it('keeps the chips when a stored name is also carried', () => {
    // The regression this guards: adding the store row AFTER the agent pass, but
    // unconditionally, would replace a populated bucket with an empty one and
    // wipe the chips off a skill several agents have.
    const entries = buildSkillEntries(
      [agent({ skills: ['security-review'] })],
      [connection(['security-review'])],
      [],
      [stored('security-review')],
    );
    const entry = entries.find(e => e.name === 'security-review')!;
    expect(entry.agents.length).toBe(1);
    expect(entry.origin).toBe('agent');
    expect(entry.stored).toBe(true);
    expect(entry.advertised).toBe(true);
  });

  it('matches a stored name to a carried one case-insensitively', () => {
    const entries = buildSkillEntries([agent({ skills: ['Security-Review'] })], [], [], [stored('security-review')]);
    // One row, not two: `read_skill` resolves case-insensitively, so a second
    // row would claim there are two different skills.
    expect(entries.filter(e => e.name.toLowerCase() === 'security-review').length).toBe(1);
  });

  it('leaves the pre-store behaviour untouched when nothing is stored', () => {
    const entries = buildSkillEntries([agent({ skills: ['browse'] })], [], []);
    const entry = entries.find(e => e.name === 'browse')!;
    expect(entry.stored).toBe(false);
    expect(entry.storedId).toBe('');
    expect(entry.origin).toBe('agent');
  });
});

describe('unresolvedSkillTokens — the dangling-reference check', () => {
  const entries = buildSkillEntries(
    [agent({ id: 'a1', skills: ['configured-only'] })],
    [connection(['advertised-skill'])],
    ['catalog-skill'],
    [stored('written-here')],
  );

  it('treats a stored, a catalog and an advertised name as backed', () => {
    expect(unresolvedSkillTokens(['written-here'], entries)).toEqual([]);
    expect(unresolvedSkillTokens(['catalog-skill'], entries)).toEqual([]);
    expect(unresolvedSkillTokens(['advertised-skill'], entries)).toEqual([]);
  });

  it('reports a name only CONFIGURED on an agent nothing confirms', () => {
    // This is the claim-without-a-procedure case the store exists to fix, so it
    // must NOT be quietly counted as backed.
    expect(unresolvedSkillTokens(['configured-only'], entries)).toEqual(['configured-only']);
  });

  it('reports a name nothing in the workspace has heard of', () => {
    expect(unresolvedSkillTokens(['security-review'], entries)).toEqual(['security-review']);
  });

  it('is case-insensitive and deduped', () => {
    expect(unresolvedSkillTokens(['WRITTEN-HERE'], entries)).toEqual([]);
    expect(unresolvedSkillTokens(['nope', 'NOPE', ' nope '], entries)).toEqual(['nope']);
  });

  it('reads a template-shaped comma list the same way the field stores it', () => {
    // The path a template actually takes: `skills.join(', ')` into the form.
    const fromTemplate = ['written-here', 'security-review'].join(', ');
    expect(unresolvedSkillTokens(parseSkillTokens(fromTemplate), entries)).toEqual(['security-review']);
  });

  it('MUTATION CHECK: with no entries every name is unresolved', () => {
    // Proves the assertions above depend on the entries rather than passing for
    // some unrelated reason.
    expect(unresolvedSkillTokens(['written-here', 'catalog-skill'], [])).toEqual(['written-here', 'catalog-skill']);
  });
});

describe('buildSkillSuggestions credits the right author', () => {
  it('labels a stored skill "Written here" and a shipped one "In agensis"', () => {
    const entries = buildSkillEntries([], [], ['catalog-skill'], [stored('written-here')]);
    const suggestions = buildSkillSuggestions(entries, null);
    expect(suggestions.find(s => s.value === 'written-here')?.detail).toBe('Written here');
    expect(suggestions.find(s => s.value === 'catalog-skill')?.detail).toBe('In agensis');
  });
});
