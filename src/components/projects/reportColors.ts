import type { Task } from '../../types';

/** Status colours shared by the report charts and the plain-markup bars. */
export const STATUS_COLORS: Record<Task['status'], string> = {
  todo: 'var(--chart-3)',
  in_progress: 'var(--chart-2)',
  done: 'var(--chart-1)',
  cancelled: 'var(--chart-5)',
};
