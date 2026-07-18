import type { Task } from '../types';

// Allowlist: only user-editable Task fields may be set by a sandboxed applet via
// the `agensis:updateTask` bridge message. Excludes ids, workspace_id,
// created_by, assignee_id, source_*, timestamps, version, and completed_at to
// prevent mass-assignment of privileged columns from untrusted iframe content.
export const APPLET_TASK_UPDATE_FIELDS = [
 'title',
 'description',
 'status',
 'priority',
 'due_date',
] as const;

/**
 * Filter an applet-supplied `updates` object down to the allowlisted, user-
 * editable Task fields. This is the single source of truth for the applet
 * mass-assignment guard — both CanvasObjectRenderer's bridge handler and the
 * unit test import THIS function, so the test exercises the real code path
 * rather than a drifting copy.
 */
export function filterAppletTaskUpdates(updates: Record<string, unknown>): Partial<Task> {
 const safeUpdates: Partial<Task> = {};
 for (const key of APPLET_TASK_UPDATE_FIELDS) {
  if (Object.prototype.hasOwnProperty.call(updates, key)) {
   (safeUpdates as Record<string, unknown>)[key] = updates[key];
  }
 }
 return safeUpdates;
}
