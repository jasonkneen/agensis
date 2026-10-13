import { GROUP_BYS, PRIORITIES, type TaskGroupBy } from './taskFilters';
import type { TaskPriority } from '../../types';

// A saved task view: the toolbar's filters, sort and view layout under a name.
// The settings are stored as JSON, so anything read back is validated field by field
// and falls back to the default. A saved view can never put the toolbar in a state it
// could not reach itself.

export type SavedViewFilter = 'all' | 'mine' | 'others';
export type SavedViewSort = 'default' | 'priority' | 'due' | 'title';
export type SavedViewLayout = 'list' | 'kanban' | 'gantt' | 'table' | 'calendar';

export interface SavedViewConfig {
  filter: SavedViewFilter;
  hideDone: boolean;
  agentsOnly: boolean;
  overdueOnly: boolean;
  search: string;
  sort: SavedViewSort;
  view: SavedViewLayout;
  /** 'all' or a project id. */
  projectId: string;
  /** Selected priorities; empty means any. */
  priorities: TaskPriority[];
  /** Selected labels; empty means any. */
  labels: string[];
  groupBy: TaskGroupBy;
}

export const DEFAULT_VIEW_CONFIG: SavedViewConfig = {
  filter: 'all',
  hideDone: false,
  agentsOnly: false,
  overdueOnly: false,
  search: '',
  sort: 'default',
  view: 'list',
  projectId: 'all',
  priorities: [],
  labels: [],
  groupBy: 'status',
};

const FILTERS: SavedViewFilter[] = ['all', 'mine', 'others'];
const SORTS: SavedViewSort[] = ['default', 'priority', 'due', 'title'];
const LAYOUTS: SavedViewLayout[] = ['list', 'kanban', 'gantt', 'table', 'calendar'];

function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return typeof value === 'string' && (allowed as string[]).includes(value) ? (value as T) : fallback;
}

/** Turns whatever was stored into a complete, valid config. */
export function normalizeViewConfig(raw: unknown): SavedViewConfig {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const search = typeof source.search === 'string' ? source.search.slice(0, 200) : DEFAULT_VIEW_CONFIG.search;
  const projectId = typeof source.projectId === 'string' && source.projectId ? source.projectId : DEFAULT_VIEW_CONFIG.projectId;
  return {
    filter: oneOf(source.filter, FILTERS, DEFAULT_VIEW_CONFIG.filter),
    hideDone: source.hideDone === true,
    agentsOnly: source.agentsOnly === true,
    overdueOnly: source.overdueOnly === true,
    search,
    sort: oneOf(source.sort, SORTS, DEFAULT_VIEW_CONFIG.sort),
    view: oneOf(source.view, LAYOUTS, DEFAULT_VIEW_CONFIG.view),
    projectId,
    priorities: Array.isArray(source.priorities) ? PRIORITIES.filter(item => (source.priorities as unknown[]).includes(item)) : [],
    labels: Array.isArray(source.labels) ? (source.labels as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 20) : [],
    groupBy: oneOf(source.groupBy, GROUP_BYS, DEFAULT_VIEW_CONFIG.groupBy),
  };
}

/** A short description of what a view does, for a tooltip: only the settings that differ from the default. */
export function describeViewConfig(config: SavedViewConfig): string {
  const parts: string[] = [];
  if (config.filter !== 'all') parts.push(config.filter === 'mine' ? 'Mine' : 'Others');
  if (config.agentsOnly) parts.push('Agent-assigned');
  if (config.overdueOnly) parts.push('Overdue');
  if (config.hideDone) parts.push('Hide done');
  if (config.search) parts.push(`"${config.search}"`);
  if (config.priorities.length) parts.push(`Priority: ${config.priorities.join('/')}`);
  if (config.labels.length) parts.push(`Labels: ${config.labels.join('/')}`);
  if (config.groupBy !== 'status') parts.push(`Group: ${config.groupBy}`);
  if (config.sort !== 'default') parts.push(`Sort: ${config.sort}`);
  parts.push(config.view);
  return parts.join(' · ');
}
