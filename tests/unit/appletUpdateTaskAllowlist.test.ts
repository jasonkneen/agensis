import { describe, it, expect } from 'vitest';

// Item 4 — applet `agensis:updateTask` field allowlist.
//
// The real logic is INLINE inside src/components/canvas/CanvasObjectRenderer.tsx
// (the `agensis:updateTask` branch, ~line 226-241). It is not exported, and that
// component is owned by another agent, so this test re-implements the EXACT
// allowlist filter below. It mirrors the component's mass-assignment guard:
// only user-editable Task fields may be set by a sandboxed applet.
//
// !!! KEEP IN SYNC with CanvasObjectRenderer.tsx APPLET_TASK_UPDATE_FIELDS !!!
const APPLET_TASK_UPDATE_FIELDS = ['title', 'description', 'status', 'priority', 'due_date'] as const;

function filterAppletTaskUpdates(updates: Record<string, unknown>): Record<string, unknown> {
  const safeUpdates: Record<string, unknown> = {};
  for (const key of APPLET_TASK_UPDATE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      safeUpdates[key] = updates[key];
    }
  }
  return safeUpdates;
}

describe('applet updateTask allowlist', () => {
  it('passes through every allowlisted field', () => {
    const updates = {
      title: 'New title',
      description: 'desc',
      status: 'in_progress',
      priority: 'high',
      due_date: '2026-01-01',
    };
    expect(filterAppletTaskUpdates(updates)).toEqual(updates);
  });

  it('drops privileged keys outside the allowlist (mass-assignment guard)', () => {
    const updates = {
      id: 'task-1',
      workspace_id: 'ws-1',
      created_by: 'user-9',
      assignee_id: 'user-2',
      title: 'allowed',
    };
    const result = filterAppletTaskUpdates(updates);
    expect(result).toEqual({ title: 'allowed' });
    expect(result).not.toHaveProperty('id');
    expect(result).not.toHaveProperty('workspace_id');
    expect(result).not.toHaveProperty('created_by');
    expect(result).not.toHaveProperty('assignee_id');
  });

  it('yields an empty (no-op) result when no allowlisted keys are present', () => {
    const result = filterAppletTaskUpdates({
      id: 'task-1',
      version: 5,
      completed_at: 'now',
    });
    expect(Object.keys(result)).toHaveLength(0);
  });

  it('does not invent missing allowlisted keys', () => {
    const result = filterAppletTaskUpdates({ status: 'done' });
    expect(result).toEqual({ status: 'done' });
    expect(result).not.toHaveProperty('title');
  });
});
