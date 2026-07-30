import { describe, expect, it } from 'vitest';
import {
  buildLibraryEntries,
  buildSkillEntries,
  catalogSkillNames,
  filterLibraries,
  filterSkills,
  isSelected,
  selectionStillExists,
  skillAgentInitials,
  toggleSkillsSelection,
  type SkillsSelection,
} from '../../src/lib/skillsView';

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Coder', handle: 'coder', run_mode: 'daemon', skills: [], enabled: true, ...over,
} as never);

const connection = (over: Record<string, unknown> = {}) => ({
  agent_id: 'a1', handle: 'coder', capabilities: { skills: [] }, ...over,
} as never);

// No catalog by default: these assert the agent-derived rows, and the catalog
// gets its own block below.
const build = (
  agents: unknown[],
  connections: unknown[] = [],
  catalog: string[] = [],
) => buildSkillEntries(agents as never, connections as never, catalog);

describe('buildSkillEntries — one row per skill, agents as chips', () => {
  it('keeps BOTH sources for a connected agent, not just the advertised list', () => {
    // The regression this replaces: taking the daemon's list INSTEAD of the
    // configured one meant every skill typed into a profile vanished the moment
    // that agent's daemon connected — including sandbox provider skills, which
    // are configured by definition and never advertised.
    const entries = build(
      [agent({ skills: ['sandbox-provider-box'] })],
      [connection({ capabilities: { skills: ['browse'] } })],
    );
    expect(entries.map(e => e.name)).toEqual(['browse', 'sandbox-provider-box']);
    expect(entries.find(e => e.name === 'browse')!.agents[0].source).toBe('advertised');
    expect(entries.find(e => e.name === 'sandbox-provider-box')!.agents[0].source).toBe('configured');
  });

  it('a skill on several agents is ONE row with several chips', () => {
    // Two agents advertising `research` means two agents can do it — that IS the
    // information, so it must not be deduped into one chip or split into two rows.
    const entries = build(
      [agent({ id: 'a1' }), agent({ id: 'a2', name: 'Scout', handle: 'scout' })],
      [
        connection({ agent_id: 'a1', capabilities: { skills: ['research'] } }),
        connection({ agent_id: 'a2', handle: 'scout', capabilities: { skills: ['research'] } }),
      ],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].agents.map(a => a.name)).toEqual(['Coder', 'Scout']);
  });

  it('a skill on one agent has exactly one chip', () => {
    const entries = build([agent({ skills: ['solo'] })]);
    expect(entries[0].agents).toHaveLength(1);
    expect(entries[0].origin).toBe('agent');
  });

  it('advertised and configured chips coexist on the same row', () => {
    // The question the page answers: Coder CAN do this (a machine said so),
    // Scout only claims to.
    const entries = build(
      [agent({ id: 'a1' }), agent({ id: 'a2', name: 'Scout', handle: 'scout', skills: ['shared'] })],
      [connection({ agent_id: 'a1', capabilities: { skills: ['shared'] } })],
    );
    expect(entries).toHaveLength(1);
    expect(Object.fromEntries(entries[0].agents.map(a => [a.name, a.source]))).toEqual({
      Coder: 'advertised',
      Scout: 'configured',
    });
    expect(entries[0].advertised).toBe(true);
  });

  it('an offline agent\'s configured skills are configured, never advertised', () => {
    const entries = build([agent({ skills: ['typed-in'] })]);
    expect(entries[0].agents[0].source).toBe('configured');
    expect(entries[0].agents[0].connected).toBe(false);
    expect(entries[0].advertised).toBe(false);
  });

  it('gives every chip initials and a colour, never an emoji', () => {
    const entries = build([agent({ name: 'Data Analyst' })], [connection({ capabilities: { skills: ['x'] } })]);
    const chip = entries[0].agents[0];
    expect(chip.initials).toBe('DA');
    expect(chip.color).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('skips disabled agents and sorts by name', () => {
    const entries = build([
      agent({ id: 'a1', skills: ['zebra'] }),
      agent({ id: 'a2', handle: 'off', skills: ['apple'], enabled: false }),
    ]);
    expect(entries.map(e => e.name)).toEqual(['zebra']);
  });

  it('ignores blank and non-string skill entries', () => {
    const entries = build([agent({ skills: ['  ', '', 'ok'] })]);
    expect(entries.map(e => e.name)).toEqual(['ok']);
  });
});

describe('skills nobody advertises still get a row', () => {
  it('a catalog skill with no agent is a row with no chips', () => {
    const entries = build([], [], ['sandbox-provider-box']);
    expect(entries.map(e => e.name)).toEqual(['sandbox-provider-box']);
    expect(entries[0].agents).toEqual([]);
    expect(entries[0].origin).toBe('catalog');
    expect(entries[0].advertised).toBe(false);
  });

  it('an agent carrying a catalog skill claims the row rather than duplicating it', () => {
    const entries = build([agent({ skills: ['sandbox-provider-box'] })], [], ['sandbox-provider-box']);
    expect(entries).toHaveLength(1);
    expect(entries[0].origin).toBe('agent');
    expect(entries[0].agents).toHaveLength(1);
  });

  it('the shipped catalog includes the sandbox provider skills', () => {
    // These have definitions agensis holds, so they are readable even with no
    // agent and no daemon — hiding them would understate what the workspace can do.
    expect(catalogSkillNames()).toContain('sandbox-provisioning');
    expect(catalogSkillNames()).toContain('sandbox-provider-box');
  });
});

describe('skillAgentInitials', () => {
  it('takes up to two initials from a name', () => {
    expect(skillAgentInitials({ name: 'Code Reviewer', handle: 'reviewer' } as never)).toBe('CR');
    expect(skillAgentInitials({ name: 'Coder', handle: 'coder' } as never)).toBe('CO');
  });

  it('falls back to the handle, then to a placeholder', () => {
    expect(skillAgentInitials({ name: '', handle: 'ops-bot' } as never)).toBe('OB');
    expect(skillAgentInitials({ name: '', handle: '' } as never)).toBe('?');
    // Punctuation-only identities still yield something legible, not '@@'.
    expect(skillAgentInitials({ name: '@@', handle: '' } as never)).toBe('?');
  });
});

describe('buildLibraryEntries', () => {
  const caps = (skills: unknown[]) => ({ skills } as never);

  it('keeps only available skill/agent libraries, biggest first', () => {
    const entries = buildLibraryEntries(caps([
      { id: 'l1', label: 'small', type: 'skills', path: '/a', available: true, count: 2 },
      { id: 'l2', label: 'big', type: 'agents', path: '/b', available: true, count: 9 },
      { id: 'l3', label: 'gone', type: 'skills', path: '/c', available: false, count: 99 },
      { id: 'l4', label: 'other', type: 'plugins', path: '/d', available: true, count: 5 },
    ]));
    expect(entries.map(e => e.id)).toEqual(['l2', 'l1']);
  });

  it('handles a null capabilities payload', () => {
    expect(buildLibraryEntries(null)).toEqual([]);
  });
});

describe('filtering', () => {
  const entries = build([agent({ skills: ['research'] })]);

  it('matches a skill by name or by an agent that has it', () => {
    expect(filterSkills(entries, 'RESEA')).toHaveLength(1);
    expect(filterSkills(entries, 'coder')).toHaveLength(1);
    expect(filterSkills(entries, 'nope')).toHaveLength(0);
  });

  it('an empty query returns everything', () => {
    expect(filterSkills(entries, '   ')).toHaveLength(1);
  });

  it('libraries match on label or path', () => {
    const libs = buildLibraryEntries({ skills: [
      { id: 'l1', label: 'Personal', type: 'skills', path: '/home/me/.claude/skills', available: true, count: 3 },
    ] } as never);
    expect(filterLibraries(libs, 'personal')).toHaveLength(1);
    expect(filterLibraries(libs, '.claude')).toHaveLength(1);
    expect(filterLibraries(libs, 'zzz')).toHaveLength(0);
  });
});

describe('selection', () => {
  const skill = { kind: 'skill', name: 'research' } as const;
  const library = { kind: 'library', id: 'research' } as const;

  it('a skill and a library with the SAME string never select each other', () => {
    // Keying on a bare string would let these collide — the bug this union type
    // exists to prevent.
    expect(isSelected(skill, library)).toBe(false);
    expect(isSelected(library, skill)).toBe(false);
    expect(isSelected(skill, skill)).toBe(true);
    expect(isSelected(library, library)).toBe(true);
  });

  it('clicking the open row again closes the pane', () => {
    expect(toggleSkillsSelection(skill, skill)).toBeNull();
    expect(toggleSkillsSelection(library, library)).toBeNull();
  });

  it('clicking a different row moves the selection', () => {
    expect(toggleSkillsSelection(skill, { kind: 'skill', name: 'other' })).toEqual({ kind: 'skill', name: 'other' });
    expect(toggleSkillsSelection(skill, library)).toEqual(library);
  });

  it('selecting from nothing selects', () => {
    expect(toggleSkillsSelection(null, skill)).toEqual(skill);
  });

  it('nothing is ever selected against a null selection', () => {
    expect(isSelected(null as SkillsSelection, skill)).toBe(false);
  });
});

describe('selectionStillExists', () => {
  const skills = build([agent({ skills: ['research'] })]);
  const libs = buildLibraryEntries({ skills: [
    { id: 'l1', label: 'Personal', type: 'skills', path: '/p', available: true, count: 1 },
  ] } as never);

  it('a skill that vanished when a daemon disconnected drops the pane', () => {
    expect(selectionStillExists({ kind: 'skill', name: 'research' }, skills, libs)).toBe(true);
    expect(selectionStillExists({ kind: 'skill', name: 'gone' }, skills, libs)).toBe(false);
  });

  it('the same holds for libraries, and null is never live', () => {
    expect(selectionStillExists({ kind: 'library', id: 'l1' }, skills, libs)).toBe(true);
    expect(selectionStillExists({ kind: 'library', id: 'l9' }, skills, libs)).toBe(false);
    expect(selectionStillExists(null, skills, libs)).toBe(false);
  });
});
