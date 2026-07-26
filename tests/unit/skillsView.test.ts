import { describe, expect, it } from 'vitest';
import {
  buildLibraryEntries,
  buildSkillEntries,
  filterLibraries,
  filterSkills,
  isSelected,
  selectionStillExists,
  toggleSkillsSelection,
  type SkillsSelection,
} from '../../src/lib/skillsView';

const agent = (over: Record<string, unknown> = {}) => ({
  id: 'a1', name: 'Coder', handle: 'coder', run_mode: 'daemon', skills: [], enabled: true, ...over,
} as never);

const connection = (over: Record<string, unknown> = {}) => ({
  agent_id: 'a1', handle: 'coder', capabilities: { skills: [] }, ...over,
} as never);

describe('buildSkillEntries', () => {
  it('prefers the LIVE daemon capabilities over the configured list', () => {
    // The machine is the authority on what it can actually do.
    const entries = buildSkillEntries(
      [agent({ skills: ['stale-skill'] })],
      [connection({ capabilities: { skills: ['real-skill'] } })],
    );
    expect(entries.map(e => e.name)).toEqual(['real-skill']);
    expect(entries[0].source).toBe('synced');
  });

  it('falls back to the configured list when nothing is connected', () => {
    const entries = buildSkillEntries([agent({ skills: ['typed-in'] })], []);
    expect(entries.map(e => e.name)).toEqual(['typed-in']);
    expect(entries[0].source).toBe('configured');
  });

  it('marks a skill synced when ANY agent advertised it live', () => {
    // One connected machine is enough to prove the skill is real, even if
    // another agent only has it configured.
    const entries = buildSkillEntries(
      [agent({ id: 'a1', skills: ['shared'] }), agent({ id: 'a2', handle: 'scout', skills: [] })],
      [connection({ agent_id: 'a2', handle: 'scout', capabilities: { skills: ['shared'] } })],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe('synced');
    expect(entries[0].agents).toHaveLength(2);
  });

  it('records per-agent connectedness, not just the group verdict', () => {
    const entries = buildSkillEntries(
      [agent({ id: 'a1', skills: ['shared'] }), agent({ id: 'a2', handle: 'scout', skills: [] })],
      [connection({ agent_id: 'a2', handle: 'scout', capabilities: { skills: ['shared'] } })],
    );
    const byId = Object.fromEntries(entries[0].agents.map(a => [a.id, a.connected]));
    expect(byId).toEqual({ a1: false, a2: true });
  });

  it('skips disabled agents and sorts by name', () => {
    const entries = buildSkillEntries(
      [
        agent({ id: 'a1', skills: ['zebra'] }),
        agent({ id: 'a2', handle: 'off', skills: ['apple'], enabled: false }),
      ],
      [],
    );
    expect(entries.map(e => e.name)).toEqual(['zebra']);
  });

  it('ignores blank and non-string skill entries', () => {
    const entries = buildSkillEntries([agent({ skills: ['  ', '', 'ok'] })], []);
    expect(entries.map(e => e.name)).toEqual(['ok']);
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
  const entries = buildSkillEntries([agent({ skills: ['research'] })], []);

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
  const skills = buildSkillEntries([agent({ skills: ['research'] })], []);
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
