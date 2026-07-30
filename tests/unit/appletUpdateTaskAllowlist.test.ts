import { describe, it, expect } from 'vitest';
import { filterAppletTaskUpdates, APPLET_TASK_UPDATE_FIELDS } from '../../src/lib/appletBridge';

// Item 4 — applet `agensis:updateTask` field allowlist.
//
// This test exercises the REAL guard: CanvasObjectRenderer's bridge handler and
// this test both import `filterAppletTaskUpdates` from src/lib/appletBridge.ts,
// so there is no drifting copy — a change to the allowlist is caught here.

describe('applet updateTask allowlist (real shared guard)', () => {
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
      version: 7,
      completed_at: 'now',
      source_agent_id: 'agent-1',
      title: 'allowed',
    };
    const result = filterAppletTaskUpdates(updates);
    expect(result).toEqual({ title: 'allowed' });
    for (const priv of ['id', 'workspace_id', 'created_by', 'assignee_id', 'version', 'completed_at', 'source_agent_id']) {
      expect(result).not.toHaveProperty(priv);
    }
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

  it('ignores prototype-inherited keys (only own properties count)', () => {
    const base = { title: 'proto-title' };
    const updates = Object.create(base) as Record<string, unknown>;
    updates.status = 'done';
    const result = filterAppletTaskUpdates(updates);
    // title lives on the prototype, not as an own property → must be dropped.
    expect(result).toEqual({ status: 'done' });
    expect(result).not.toHaveProperty('title');
  });

  it('exposes a stable allowlist (guards accidental widening)', () => {
    expect([...APPLET_TASK_UPDATE_FIELDS]).toEqual(['title', 'description', 'status', 'priority', 'due_date']);
  });
});
