// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import React, { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import fs from 'node:fs';
import path from 'node:path';

const channels: Array<{
  name: string;
  config?: Record<string, unknown>;
  callback?: (payload: unknown) => void;
  unsubscribe: ReturnType<typeof vi.fn>;
}> = [];

vi.mock('../../src/lib/backendClient', () => ({
  backendClient: {
    channel(name: string) {
      const record = { name, unsubscribe: vi.fn() };
      channels.push(record);
      const handle = {
        on(_type: string, config: Record<string, unknown>, callback: (payload: unknown) => void) {
          record.config = config;
          record.callback = callback;
          return handle;
        },
        subscribe() { return handle; },
        unsubscribe() {
          record.unsubscribe();
          return Promise.resolve('ok');
        },
      };
      return handle;
    },
  },
}));

const {
  isSessionClosure,
  useSessionClosureSignal,
} = await import('../../src/hooks/useSessionClosureSignal');

const SESSION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const roots: Array<{ root: Root; container: HTMLDivElement }> = [];

function TranscriptView({ label }: { label: string }) {
  const [message, setMessage] = useState(`${label}: secret body`);
  useSessionClosureSignal(SESSION, () => setMessage(`${label}: closed`));
  return React.createElement('div', { 'data-view': label }, message);
}

function mountTwoViews() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  act(() => {
    root.render(React.createElement(
      React.Fragment,
      null,
      React.createElement(TranscriptView, { label: 'active' }),
      React.createElement(TranscriptView, { label: 'inactive' }),
    ));
  });
  return container;
}

afterEach(() => {
  for (const mounted of roots.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  channels.splice(0);
});

describe('session closure signal', () => {
  it('recognizes only a deleted UPDATE for the exact session', () => {
    expect(isSessionClosure({
      eventType: 'UPDATE',
      new: { id: SESSION, deleted_at: '2026-07-31T12:00:00.000Z', updated_at: '2026-07-31T12:00:00.000Z' },
    }, SESSION)).toBe(true);
    expect(isSessionClosure({
      eventType: 'UPDATE',
      new: { id: 'other', deleted_at: '2026-07-31T12:00:00.000Z', updated_at: '2026-07-31T12:00:00.000Z' },
    }, SESSION)).toBe(false);
    expect(isSessionClosure({
      eventType: 'UPDATE',
      new: { id: SESSION, deleted_at: null, updated_at: '2026-07-31T12:00:00.000Z' },
    }, SESSION)).toBe(false);
  });

  it('invalidates two independently rendered views from one bounded session row', () => {
    const container = mountTwoViews();
    expect(container.textContent).toContain('active: secret body');
    expect(container.textContent).toContain('inactive: secret body');
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe(`session-lifecycle:${SESSION}`);
    expect(channels[0].config).toMatchObject({
      table: 'chat_sessions',
      event: 'UPDATE',
      filter: `id=eq.${SESSION}`,
    });

    act(() => {
      channels[0].callback?.({
        eventType: 'UPDATE',
        new: {
          id: SESSION,
          deleted_at: '2026-07-31T12:00:00.000Z',
          updated_at: '2026-07-31T12:00:00.000Z',
        },
      });
    });

    expect(container.textContent).toContain('active: closed');
    expect(container.textContent).toContain('inactive: closed');
    expect(container.textContent).not.toContain('secret body');
  });

  it('is consumed by inactive and sub-thread message surfaces', () => {
    for (const relative of [
      'src/hooks/useSessionMessages.ts',
      'src/hooks/useSubThreads.ts',
    ]) {
      const source = fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
      expect(source).toMatch(/useSessionClosureSignal\(/);
    }
  });

  it('uses the canonical workspace session feed for the active chat surface', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/hooks/useChat.ts'),
      'utf8',
    );
    expect(source).toMatch(/channelName: `chat-sessions:\$\{workspaceId/);
    expect(source).toMatch(/reconcileWorkspaceSessions\(/);
  });
});
