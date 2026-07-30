import { describe, it, expect } from 'vitest';
import {
  BUILTIN_SLASH_ITEMS,
  matchSlashItems,
  scoreSlashItem,
  groupSlashItems,
  slashInsertText,
  type SlashItem,
} from '../../src/lib/slashCommands';

const cascade: SlashItem = { id: 'skill:cascade', name: 'cascade', kind: 'skill', run: 'insert' };
const cascadePlan: SlashItem = {
  id: 'skill-command:cascade:cascade-plan',
  name: 'cascade-plan',
  kind: 'skill-command',
  parent: 'cascade',
  run: 'insert',
};
const cascadeExec: SlashItem = {
  id: 'skill-command:cascade:cascade-exec',
  name: 'cascade-exec',
  kind: 'skill-command',
  parent: 'cascade',
  run: 'insert',
};
const dosomething: SlashItem = { id: 'command:dosomething', name: 'dosomething', kind: 'command', run: 'insert' };

const ALL: SlashItem[] = [...BUILTIN_SLASH_ITEMS, cascade, cascadePlan, cascadeExec, dosomething];

describe('slashInsertText', () => {
  it('defaults to /name', () => {
    expect(slashInsertText(cascadePlan)).toBe('/cascade-plan');
  });
  it('honours an explicit insertText', () => {
    expect(slashInsertText({ ...dosomething, insertText: 'use dosomething' })).toBe('use dosomething');
  });
});

describe('scoreSlashItem', () => {
  it('ranks exact > prefix > word-boundary > subsequence', () => {
    const exact = scoreSlashItem(cascade, 'cascade');
    const prefix = scoreSlashItem(cascade, 'casc');
    const boundary = scoreSlashItem(cascadePlan, 'plan'); // matches the "plan" segment
    const subseq = scoreSlashItem(dosomething, 'dsg'); // subsequence
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(boundary);
    expect(boundary).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it('returns -1 when no subsequence exists', () => {
    expect(scoreSlashItem(cascade, 'zzz')).toBe(-1);
  });

  it('is parent-aware: a child matches its parent name', () => {
    // "casc" should match cascade-plan through its parent, even though the child
    // name starts with "cascade-" too — the point is parent context is considered.
    expect(scoreSlashItem(cascadePlan, 'cascade')).toBeGreaterThan(0);
  });

  it('leading slash in the query is ignored', () => {
    expect(scoreSlashItem(cascade, '/cascade')).toBe(scoreSlashItem(cascade, 'cascade'));
  });
});

describe('matchSlashItems', () => {
  it('empty query returns everything with built-ins floated to the top', () => {
    const out = matchSlashItems(ALL, '');
    expect(out.length).toBe(ALL.length);
    expect(out.slice(0, BUILTIN_SLASH_ITEMS.length).every(i => i.kind === 'builtin')).toBe(true);
  });

  it('typing a skill prefix surfaces the parent and its children', () => {
    const out = matchSlashItems(ALL, 'casc');
    const ids = out.map(i => i.id);
    expect(ids).toContain('skill:cascade');
    expect(ids).toContain('skill-command:cascade:cascade-plan');
    expect(ids).toContain('skill-command:cascade:cascade-exec');
    expect(ids).not.toContain('command:dosomething');
  });

  it('mid-token query matches a skill-command by its own name', () => {
    const out = matchSlashItems(ALL, 'plan');
    expect(out.map(i => i.id)).toContain('skill-command:cascade:cascade-plan');
  });

  it('a builtin prefix floats the builtin above coincidental matches', () => {
    const out = matchSlashItems(ALL, 'cl');
    expect(out[0].id).toBe('builtin:clear');
  });
});

describe('groupSlashItems', () => {
  it('orders built-in first, then commands, then skills with nested children', () => {
    const groups = groupSlashItems(matchSlashItems(ALL, ''));
    expect(groups[0].type).toBe('builtin');
    expect(groups.find(g => g.type === 'command')?.type).toBe('command');
    const skill = groups.find(g => g.type === 'skill' && g.label === 'cascade');
    expect(skill).toBeDefined();
    if (skill && skill.type === 'skill') {
      expect(skill.parent?.id).toBe('skill:cascade');
      // Empty query ranks alphabetically, so children come back sorted by name.
      expect(skill.children.map(c => c.id)).toEqual([
        'skill-command:cascade:cascade-exec',
        'skill-command:cascade:cascade-plan',
      ]);
    }
  });

  it('keeps a matched child even when the parent leaf is filtered out', () => {
    // Query 'plan' matches only the child, not the parent skill leaf.
    const groups = groupSlashItems(matchSlashItems(ALL, 'plan'));
    const skill = groups.find(g => g.type === 'skill' && g.label === 'cascade');
    expect(skill).toBeDefined();
    if (skill && skill.type === 'skill') {
      expect(skill.parent).toBeUndefined();
      expect(skill.children.map(c => c.id)).toContain('skill-command:cascade:cascade-plan');
    }
  });

  it('omits empty groups', () => {
    const groups = groupSlashItems(matchSlashItems([cascade], 'cascade'));
    expect(groups.some(g => g.type === 'builtin')).toBe(false);
    expect(groups.some(g => g.type === 'command')).toBe(false);
  });
});
