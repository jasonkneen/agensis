// Guards the fix in src/components/windows/WindowBodies.tsx.
//
// The window contents are wrapped in React.memo, but memo compares props
// shallowly — so a single inline arrow (`onSendMessage={() => ...}`) or a fresh
// array literal (`messages={... : []}`) written in the parent is a NEW reference
// every render and the memo never hits. That is exactly what App.tsx used to do
// inside `renderedWindows.map`, which re-rendered ~3.8k lines of ChatWindowContent
// on every single App state change (every streamed token, every cursor frame).
//
// These tests assert the memoized child renders ONCE across repeated parent
// re-renders with unchanged inputs. The `control` test at the bottom reproduces
// the old inline-arrow pattern and asserts it does NOT hold — without it, a
// passing suite here would prove nothing (a memo that never receives a second
// render would also "pass").
//
// Written with createElement rather than JSX so it stays a .ts file and vitest's
// existing `tests/unit/**/*.test.ts` include needs no config change.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createElement, useState, act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

const counters = vi.hoisted(() => ({ chat: 0, doc: 0, tasks: 0 }));

vi.mock('../../src/components/windows/ChatWindowContent', async () => {
  const { memo: m } = await vi.importActual<typeof import('react')>('react');
  return { ChatWindowContent: m(function ChatWindowContent() { counters.chat++; return null; }) };
});
vi.mock('../../src/components/windows/DocWindowContent', async () => {
  const { memo: m } = await vi.importActual<typeof import('react')>('react');
  return { DocWindowContent: m(function DocWindowContent() { counters.doc++; return null; }) };
});
vi.mock('../../src/components/windows/TasksWindowContent', async () => {
  const { memo: m } = await vi.importActual<typeof import('react')>('react');
  return { TasksWindowContent: m(function TasksWindowContent() { counters.tasks++; return null; }) };
});

const { ChatWindowBody, DocWindowBody, TasksWindowBody } = await import(
  '../../src/components/windows/WindowBodies'
);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Mount `renderChild` under a parent, then re-render that parent `times` more
 * times. `renderChild` is invoked afresh on every parent render — so the child
 * ELEMENT is always a new object, exactly as in App's `renderedWindows.map`.
 * Only referential stability of the child's PROPS can save the memo here; if the
 * element identity did the saving, the test would be lying.
 */
async function renderThenRerender(renderChild: () => ReactNode, times: number) {
  let bump!: () => void;

  function Parent() {
    const [, setN] = useState(0);
    bump = () => setN(n => n + 1);
    return renderChild();
  }

  const container = document.createElement('div');
  const root = createRoot(container);

  await act(async () => { root.render(createElement(Parent)); });
  for (let i = 0; i < times; i++) {
    await act(async () => { bump(); });
  }
  await act(async () => { root.unmount(); });
}

// Stable inputs, defined once. In the real app these come from hooks/useMemo;
// what matters is that the BODY must not add churn of its own on top of them.
const session = { id: 's1', title: 'Chat' } as never;
const stable = {
  messages: [] as never[],
  memoryFacts: [] as never[],
  documents: [] as never[],
  agents: [] as never[],
  agentConnections: [] as never[],
  presenceUsers: [] as never[],
  canvasGroups: [] as never[],
  canvasObjects: [] as never[],
  uploadedFiles: [] as never[],
  tasks: [] as never[],
  members: [] as never[],
  workspaceId: 'w1',
  activeThreadId: null,
};
const noop = () => {};

beforeEach(() => {
  counters.chat = 0;
  counters.doc = 0;
  counters.tasks = 0;
});

describe('window bodies keep React.memo alive across parent re-renders', () => {
  it('ChatWindowBody renders the memoized chat content exactly once', async () => {
    const props = {
      ...stable,
      winSession: session,
      isActiveSession: true,
      onAppSendMessage: noop,
      onSetActiveSession: noop,
      onAppSplitThread: noop,
    } as never;

    await renderThenRerender(() => createElement(ChatWindowBody, props), 4);

    // 5 parent renders (1 mount + 4 bumps), 1 chat render.
    expect(counters.chat).toBe(1);
  });

  it('DocWindowBody renders the memoized doc content exactly once', async () => {
    const props = {
      ...stable,
      windowId: 'win-doc',
      document: { id: 'd1', title: 'Doc' },
      onDeleteDocument: noop,
      onCloseWindow: noop,
      onUpdateWindow: noop,
      onRequestConfirm: noop,
      onAutoSave: noop,
      onToggleFavorite: noop,
      onCommentCreated: noop,
      onUpdateTask: noop,
    } as never;

    await renderThenRerender(() => createElement(DocWindowBody, props), 4);

    expect(counters.doc).toBe(1);
  });

  it('TasksWindowBody renders the memoized tasks content exactly once', async () => {
    const props = {
      ...stable,
      windowId: 'win-tasks',
      onUpdateWindow: noop,
      onCreateTask: noop,
      onUpdateTask: noop,
      onToggleStatus: noop,
      onDeleteTask: noop,
      onUpdateAgent: noop,
      focusTaskId: undefined,
    } as never;

    await renderThenRerender(() => createElement(TasksWindowBody, props), 4);

    expect(counters.tasks).toBe(1);
  });

  // Control: the bug this fix removes. If this test ever goes GREEN (count === 1)
  // the harness above has stopped being able to observe the defect, and the three
  // tests above are worthless — they'd pass no matter what the bodies did.
  it('control: an inline arrow in the parent defeats the memo (the original bug)', async () => {
    const props = {
      ...stable,
      winSession: session,
      isActiveSession: true,
      onSetActiveSession: noop,
      onAppSplitThread: noop,
    };

    await renderThenRerender(
      // Fresh closure on every parent render — precisely the old App.tsx pattern.
      () => createElement(ChatWindowBody, { ...props, onAppSendMessage: () => {} } as never),
      4,
    );

    expect(counters.chat).toBe(5);
  });
});
