import type { Task } from '../../types';

/** Status colours shared by the report charts and the plain-markup bars. */
// Fixed hues, not the theme's chart ramp: several themes make that ramp grey, which turns
// every series the same colour. These read on both light and dark backgrounds.
export const STATUS_COLORS: Record<Task['status'], string> = {
  backlog: '#a8a39a',
  todo: '#8a867e',
  in_progress: '#d98a24',
  in_review: '#7a5ad8',
  done: '#2f9e6a',
  cancelled: '#6b7280',
};

export const SERIES_COLORS = {
  remaining: 'var(--primary)',
  ideal: '#8a867e',
  velocity: 'var(--primary)',
  created: '#7a5ad8',
  completed: '#2f9e6a',
};
