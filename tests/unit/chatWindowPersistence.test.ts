import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FloatingWindowShell } from '../../src/components/windows/FloatingWindowShell';
import type { FloatingWindow } from '../../src/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const appSource = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
const shellSource = readFileSync(
  resolve(process.cwd(), 'src/components/windows/FloatingWindowShell.tsx'),
  'utf8',
);
const threadPanelSource = readFileSync(
  resolve(process.cwd(), 'src/components/chat/ChatThreadPanel.tsx'),
  'utf8',
);
const chatWindowSource = readFileSync(
  resolve(process.cwd(), 'src/components/windows/ChatWindowContent.tsx'),
  'utf8',
);

const baseWindow: FloatingWindow = {
  id: 'chat-window-1',
  type: 'chat',
  title: 'Persistent chat',
  x: 24,
  y: 24,
  width: 640,
  height: 480,
  zIndex: 101,
  minimized: false,
  sessionId: 'session-1',
};

const noop = () => {};
let mountedDrafts = 0;
let unmountedDrafts = 0;
let root: Root | null = null;

function StatefulDraft() {
  const [draft, setDraft] = useState('Initial draft');
  useEffect(() => {
    mountedDrafts += 1;
    return () => { unmountedDrafts += 1; };
  }, []);

  return createElement(
    'div',
    null,
    createElement('input', { 'aria-label': 'Draft focus target' }),
    createElement('output', { 'data-draft': true }, draft),
    createElement('button', { type: 'button', onClick: () => setDraft('Saved draft') }, 'Change draft'),
  );
}

function shell(hidden: boolean, minimized: boolean, canControl = true, bodyInteractive = false) {
  return createElement(FloatingWindowShell, {
    window: { ...baseWindow, minimized },
    hidden,
    canControl,
    bodyInteractive,
    onClose: noop,
    onFocus: noop,
    onUpdate: noop,
    onMinimize: noop,
  }, createElement(StatefulDraft));
}

afterEach(async () => {
  if (root) {
    await act(async () => { root?.unmount(); });
    root = null;
  }
  document.body.innerHTML = '';
  mountedDrafts = 0;
  unmountedDrafts = 0;
});

describe('persistent chat window mounting', () => {
  it('keeps one draft subtree across hidden and minimized visibility changes', async () => {
    const container = document.createElement('div');
    container.setAttribute('data-workspace-viewport', '');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => { root?.render(shell(false, false)); });
    const originalShell = container.querySelector<HTMLElement>('[data-floating-window]');
    const draftButton = container.querySelector<HTMLButtonElement>('button:not([aria-label])');
    const focusTarget = container.querySelector<HTMLInputElement>('[aria-label="Draft focus target"]');
    expect(originalShell).not.toBeNull();
    expect(draftButton).not.toBeNull();
    expect(focusTarget).not.toBeNull();

    await act(async () => { draftButton?.click(); });
    focusTarget?.focus();
    expect(document.activeElement).toBe(focusTarget);
    expect(container.querySelector('[data-draft]')?.textContent).toBe('Saved draft');
    expect(mountedDrafts).toBe(1);
    expect(unmountedDrafts).toBe(0);

    // Full-expand/mobile filtering uses the explicit hidden prop.
    await act(async () => { root?.render(shell(true, false)); });
    const hiddenShell = container.querySelector<HTMLElement>('[data-floating-window]');
    expect(hiddenShell).toBe(originalShell);
    expect(hiddenShell?.hidden).toBe(true);
    expect(hiddenShell?.dataset.windowHidden).toBe('true');
    expect(hiddenShell?.hasAttribute('inert')).toBe(true);
    expect(document.activeElement).not.toBe(focusTarget);
    expect(container.querySelector('[data-draft]')?.textContent).toBe('Saved draft');
    expect(mountedDrafts).toBe(1);
    expect(unmountedDrafts).toBe(0);

    await act(async () => { root?.render(shell(false, false)); });
    expect(container.querySelector<HTMLElement>('[data-floating-window]')).toBe(originalShell);
    expect(container.querySelector('[data-draft]')?.textContent).toBe('Saved draft');

    // Dock minimization uses window.minimized, but must preserve the same tree.
    await act(async () => { root?.render(shell(false, true)); });
    expect(container.querySelector<HTMLElement>('[data-floating-window]')?.hidden).toBe(true);
    expect(container.querySelector('[data-draft]')?.textContent).toBe('Saved draft');
    await act(async () => { root?.render(shell(false, false)); });
    expect(container.querySelector('[data-draft]')?.textContent).toBe('Saved draft');
    expect(mountedDrafts).toBe(1);
    expect(unmountedDrafts).toBe(0);
  });

  it('keeps all chats in App mounting while only visible windows paint', () => {
    expect(appSource).toContain("renderedWindowIds.has(win.id) || win.type === 'chat'");
    expect(appSource).toContain('{mountedWindows.map(win => {');
    expect(appSource).toContain('hidden={!renderedWindowIds.has(win.id)}');
    expect(shellSource).not.toContain('if (win.minimized) return null');
    expect(shellSource).toContain("data-window-hidden={isHidden ? 'true' : undefined}");
  });

  it('keeps a collaborator transcript interactive while other read-only bodies remain gated', async () => {
    const container = document.createElement('div');
    container.setAttribute('data-workspace-viewport', '');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(FloatingWindowShell, {
        window: baseWindow,
        canControl: false,
        bodyInteractive: true,
        onClose: noop,
        onFocus: noop,
        onUpdate: noop,
        onMinimize: noop,
      }, createElement('div', { 'data-read-only-body': true }, 'Transcript')));
    });
    const body = container.querySelector<HTMLElement>('[data-window-surface] > div:last-child');
    expect(body?.className).not.toContain('pointer-events-none');

    await act(async () => {
      root?.render(createElement(FloatingWindowShell, {
        window: baseWindow,
        canControl: false,
        onClose: noop,
        onFocus: noop,
        onUpdate: noop,
        onMinimize: noop,
      }, createElement('div', { 'data-read-only-body': true }, 'Document')));
    });
    const gatedBody = container.querySelector<HTMLElement>('[data-window-surface] > div:last-child');
    expect(gatedBody?.className).toContain('pointer-events-none');
  });

  it('uses ChatWindowBody for the Agents conversation pane', () => {
    const agentsCallback = appSource.slice(
      appSource.indexOf('renderSessionChat={session => {'),
      appSource.indexOf('renderSessionChat={session => {') + 4500,
    );
    expect(appSource).not.toContain('InactiveChatWindow');
    expect(agentsCallback).toContain('<ChatWindowBody');
    expect(agentsCallback).toContain('winSession={session}');
    expect(agentsCallback).toContain('isActiveSession={isActiveSession}');
    expect(agentsCallback).toContain('onSetActiveSession(session);');
    expect(agentsCallback).toContain('queueMicrotask(() => onOpenThread(messageId));');
    expect(appSource).toContain('if (winSession) onSetActiveSession(winSession);');
  });

  it('keeps shared chat transcripts and thread panels mounted read-only', () => {
    const chatBranch = appSource.slice(
      appSource.indexOf("if (win.type === 'chat')"),
      appSource.indexOf("if (win.type === 'document')"),
    );
    expect(chatBranch).toContain('<ReadOnlyChatWindowContent');
    expect(chatBranch).toContain('subThreadsByMessage={subThreadsByMessage}');
    expect(chatBranch).toContain('onOpenSubThread={onOpenSubThread}');
    expect(chatBranch).toContain('onCloseSubThread={onCloseSubThread}');
    expect(appSource).toContain('readOnly');
  });

  it('keeps ordinary thread history pageable instead of silently capping at the first page', () => {
    expect(threadPanelSource).toContain('hasMoreMessages?: boolean;');
    expect(threadPanelSource).toContain("'Load earlier messages'");
    const threadCall = chatWindowSource.slice(
      chatWindowSource.indexOf('<ChatThreadPanel'),
      chatWindowSource.indexOf('<ChatThreadPanel') + 900,
    );
    expect(threadCall).toContain('hasMoreMessages={hasMoreMessages}');
    expect(threadCall).toContain('onLoadEarlier={onLoadEarlier}');
  });
});
