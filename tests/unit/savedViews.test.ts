import { describe, expect, it } from 'vitest';
import { DEFAULT_VIEW_CONFIG, describeViewConfig, normalizeViewConfig } from '../../src/lib/pm/savedViews';

describe('normalizeViewConfig', () => {
  it('returns the default for anything that is not an object', () => {
    for (const raw of [null, undefined, 'x', 5, []]) expect(normalizeViewConfig(raw)).toEqual(DEFAULT_VIEW_CONFIG);
  });

  it('keeps valid settings', () => {
    const config = { filter: 'mine', hideDone: true, agentsOnly: true, overdueOnly: true, search: 'pricing', sort: 'due', view: 'kanban', projectId: 'p1', priorities: ['high'], labels: ['design'], groupBy: 'assignee' };
    expect(normalizeViewConfig(config)).toEqual(config);
  });

  it('gives a view saved before priority, label and group filters existed their defaults', () => {
    const result = normalizeViewConfig({ filter: 'mine', sort: 'due' });
    expect(result.priorities).toEqual([]);
    expect(result.labels).toEqual([]);
    expect(result.groupBy).toBe('status');
  });

  it('drops unknown priorities, non-string labels and an unknown group', () => {
    const result = normalizeViewConfig({ priorities: ['high', 'nope'], labels: ['a', 3, null], groupBy: 'colour' });
    expect(result.priorities).toEqual(['high']);
    expect(result.labels).toEqual(['a']);
    expect(result.groupBy).toBe('status');
  });

  it('replaces an unknown filter, sort or layout with the default', () => {
    const result = normalizeViewConfig({ filter: 'everyone', sort: 'random', view: 'wall' });
    expect(result.filter).toBe('all');
    expect(result.sort).toBe('default');
    expect(result.view).toBe('list');
  });

  it('treats only true as true, so a string "true" cannot turn a filter on', () => {
    const result = normalizeViewConfig({ hideDone: 'true', agentsOnly: 1, overdueOnly: 'yes' });
    expect(result.hideDone).toBe(false);
    expect(result.agentsOnly).toBe(false);
    expect(result.overdueOnly).toBe(false);
  });

  it('falls back for a missing or empty project and caps a long search', () => {
    expect(normalizeViewConfig({ projectId: '' }).projectId).toBe('all');
    expect(normalizeViewConfig({ search: 'x'.repeat(500) }).search).toHaveLength(200);
  });
});

describe('describeViewConfig', () => {
  it('lists only what differs from the default, and always the layout', () => {
    expect(describeViewConfig(DEFAULT_VIEW_CONFIG)).toBe('list');
    expect(describeViewConfig({ ...DEFAULT_VIEW_CONFIG, filter: 'mine', overdueOnly: true, sort: 'priority', view: 'table' })).toBe('Mine · Overdue · Sort: priority · table');
  });
});
