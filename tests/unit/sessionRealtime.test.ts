import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  reconcileWorkspaceSessions,
  windowsClosedWithSessions,
} from '../../src/lib/sessionRealtime';
import type { ChatSession, FloatingWindow } from '../../src/types';

const WORKSPACE = 'workspace-1';

function session(id: string, patch: Partial<ChatSession> = {}): ChatSession {
  return {
    id,
    workspace_id: WORKSPACE,
    title: id,
    model: 'auto',
    created_at: '2026-07-31T12:00:00.000Z',
    updated_at: '2026-07-31T12:00:00.000Z',
    ...patch,
  };
}

describe('canonical workspace chat-session reconciliation', () => {
  it('upserts a second human create and remote rename without duplication', () => {
    const created = session('remote', { title: 'Created elsewhere' });
    const afterCreate = reconcileWorkspaceSessions([], {
      eventType: 'INSERT',
      new: created,
    }, WORKSPACE);
    expect(afterCreate.sessions).toEqual([created]);

    const renamed = { ...created, title: 'Renamed elsewhere', updated_at: '2026-07-31T12:01:00.000Z' };
    const afterRename = reconcileWorkspaceSessions(afterCreate.sessions, {
      eventType: 'UPDATE',
      new: renamed,
    }, WORKSPACE);
    expect(afterRename.sessions).toHaveLength(1);
    expect(afterRename.sessions[0].title).toBe('Renamed elsewhere');
  });

  it('carries remote archive metadata and ignores huddle/sub-thread rows', () => {
    const existing = session('channel');
    const archived = { ...existing, archived_at: '2026-07-31T12:02:00.000Z' };
    expect(reconcileWorkspaceSessions([existing], {
      eventType: 'UPDATE',
      new: archived,
    }, WORKSPACE).sessions[0].archived_at).toBe(archived.archived_at);

    const subthread = session('sub', { parent_message_id: 'message-1' });
    const huddle = session('huddle', { folder: 'huddle' });
    expect(reconcileWorkspaceSessions([existing], {
      eventType: 'INSERT',
      new: subthread,
    }, WORKSPACE).sessions).toEqual([existing]);
    expect(reconcileWorkspaceSessions([existing], {
      eventType: 'INSERT',
      new: huddle,
    }, WORKSPACE).sessions).toEqual([existing]);
  });

  it('removes a private session and identifies every active/inactive window to close', () => {
    const privateSession = session('dm', {
      visibility: 'private',
      folder: 'Direct messages',
      deleted_at: '2026-07-31T12:03:00.000Z',
    });
    const other = session('channel');
    const result = reconcileWorkspaceSessions([privateSession, other], {
      eventType: 'UPDATE',
      new: privateSession,
    }, WORKSPACE);
    expect(result.sessions).toEqual([other]);
    expect(result.closedSessionId).toBe('dm');

    const windows = [
      { id: 'active-window', sessionId: 'dm' },
      { id: 'inactive-window', sessionId: 'dm' },
      { id: 'other-window', sessionId: 'channel' },
    ] as FloatingWindow[];
    expect(windowsClosedWithSessions(windows, ['dm'])).toEqual([
      'active-window',
      'inactive-window',
    ]);
  });

  it('keeps the workspace subscription and floating-window cleanup wired', () => {
    const hook = fs.readFileSync(path.resolve(process.cwd(), 'src/hooks/useChat.ts'), 'utf8');
    const app = fs.readFileSync(path.resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(hook).toMatch(/channelName: `chat-sessions:\$\{workspaceId/);
    expect(hook).toMatch(/filter: `workspace_id=eq\.\$\{workspaceId/);
    expect(hook).toContain('reconcileWorkspaceSessions(prev, payload, workspaceId)');
    expect(app).toContain('windowsClosedWithSessions(windows, closedSessionIds)');
  });
});
