import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HomeCanvas } from '../../src/components/home/HomeCanvas';

vi.mock('../../src/components/onboarding/OwnerMessageBanner', () => ({ OwnerMessageBanner: () => null }));
vi.mock('../../src/lib/backendClient', () => ({ getSlashCommands: vi.fn(async () => []) }));

it('stops painting the covered desktop and restores its existing draft when revealed', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = (hidden: boolean) => act(() => root.render(React.createElement(HomeCanvas, {
    documents: [], memoryFacts: [], workspaceName: 'Workspace', backgroundImage: '',
    onSendMessage: vi.fn(), onOpenNewDocument: vi.fn(), hidden,
  } as React.ComponentProps<typeof HomeCanvas>)));
  try {
    render(false);
    const textarea = host.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep my draft');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    render(true);
    const desktop = host.firstElementChild as HTMLElement;
    expect(desktop.hidden).toBe(true);
    expect(desktop.style.display).toBe('none');
    expect(desktop.hasAttribute('inert')).toBe(true);
    render(false);
    expect(desktop.hidden).toBe(false);
    expect(desktop.style.display).toBe('');
    expect(desktop.hasAttribute('inert')).toBe(false);
    expect(host.querySelector('textarea')).toBe(textarea);
    expect(textarea.value).toBe('Keep my draft');
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
