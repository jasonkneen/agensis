import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CommandPalette from '../../src/components/search/CommandPalette';
import type { ChatSession } from '../../src/types';

vi.mock('../../src/lib/backendClient', () => ({ backendClient: { from: vi.fn() } }));
vi.mock('@agensis/ui/components/command', () => {
  const container = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { Command: container, CommandDialog: container, CommandEmpty: container, CommandGroup: container,
    CommandInput: () => null, CommandItem: container, CommandList: container };
});

let root: Root | undefined;
let host: HTMLDivElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  vi.unstubAllGlobals();
});

describe('closed command palette', () => {
  it('does no result construction on unrelated updates, but builds fresh results when opened', () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    const readTitle = vi.fn(() => 'Searchable session');
    const session = { id: 'session-1', get title() { return readTitle(); } } as ChatSession;
    const render = (open: boolean) => act(() => root!.render(React.createElement(CommandPalette, {
      open, onClose: vi.fn(), documents: [], sessions: [session], facts: [], tasks: [],
      onDocumentOpen: vi.fn(), onSessionOpen: vi.fn(), onViewChange: vi.fn(),
    })));
    render(false);
    render(false);
    expect(readTitle).not.toHaveBeenCalled();
    render(true);
    expect(host.textContent).toContain('Searchable session');
    readTitle.mockClear();
    render(false);
    render(false);
    expect(readTitle).not.toHaveBeenCalled();
  });
});
