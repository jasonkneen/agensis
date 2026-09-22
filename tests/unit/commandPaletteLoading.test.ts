import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CommandPalette from '../../src/components/search/CommandPalette';
import type { Document } from '../../src/types';

const { from } = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock('../../src/lib/backendClient', () => ({ backendClient: { from } }));
vi.mock('@agensis/ui/components/command', () => {
  const container = ({ children }: { children?: React.ReactNode }) => React.createElement('div', null, children);
  return { Command: container, CommandDialog: container, CommandEmpty: container, CommandGroup: container,
    CommandInput: () => null, CommandList: container,
    CommandItem: ({ children, value }: { children?: React.ReactNode; value: string }) => React.createElement('div', { 'data-result': value }, children) };
});
type Response = { data: { id: string; content: string }[] | null; error: { message: string } | null };
let requests: { resolve: (response: Response) => void; signal: AbortSignal; workspace: string }[];
let host: HTMLDivElement;
let root: Root;
const doc = (id = 'doc-1', workspace = 'workspace-a', revision = '1') => ({ id, workspace_id: workspace, updated_at: revision, title: 'Repeated title', content: '' }) as Document;
function render(open: boolean, documents = [doc()]) {
  act(() => root.render(React.createElement(CommandPalette, { open, documents, sessions: [], facts: [],
    onClose: vi.fn(), onDocumentOpen: vi.fn(), onSessionOpen: vi.fn(), onViewChange: vi.fn() })));
}
async function finish(index: number, content: string) {
  await act(async () => requests[index].resolve({ data: [{ id: 'doc-1', content }], error: null }));
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  requests = [];
  from.mockImplementation(() => ({ select: () => ({ eq: (_column: string, workspace: string) => ({
    abortSignal: (signal: AbortSignal) => new Promise<Response>(resolve => requests.push({ resolve, signal, workspace })),
  }) }) }));
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it('shows loading, clears bodies on close and ignores responses from the closed request', async () => {
  render(true);
  expect(host.textContent).toContain('Loading document contents');
  render(false);
  expect(requests[0].signal.aborted).toBe(true);
  await finish(0, 'stale body');
  render(true);
  expect(host.textContent).not.toContain('stale body');
  await finish(1, '<p>fresh body</p>');
  expect(host.textContent).toContain('fresh body');
  expect(host.textContent).not.toContain('Loading document contents');
  render(false); render(true);
  expect(host.textContent).not.toContain('fresh body');
});
it('invalidates old revisions immediately and aborts superseded workspace reads', async () => {
  render(true); await finish(0, 'previous revision');
  render(true, [doc('doc-1', 'workspace-a', '2')]);
  expect(host.textContent).not.toContain('previous revision');
  render(true, [doc('doc-1', 'workspace-b', '2')]);
  expect(requests[1].signal.aborted).toBe(true);
  expect(requests[2].workspace).toBe('workspace-b');
  await finish(1, 'late previous workspace');
  expect(host.textContent).not.toContain('late previous workspace');
  await finish(2, 'current workspace');
  expect(host.textContent).toContain('current workspace');
});
it('aborts a stalled request and exposes a retry after a failed read', async () => {
  vi.useFakeTimers(); render(true);
  act(() => vi.advanceTimersByTime(20_000));
  expect(requests[0].signal.aborted).toBe(true);
  await act(async () => requests[0].resolve({ data: null, error: { message: 'Aborted' } }));
  expect(host.textContent).toContain('Document contents could not be loaded');
  act(() => host.querySelector('button')?.click());
  expect(requests).toHaveLength(2);
  expect(host.textContent).toContain('Loading document contents');
  await finish(1, 'retried body');
  expect(host.textContent).toContain('retried body');
});
it('uses distinct selection identities for results with identical titles and bodies', () => {
  render(true, [doc('doc-1'), doc('doc-2')]);
  expect([...host.querySelectorAll('[data-result^="doc-"]')].map(row => row.getAttribute('data-result')))
    .toEqual(['doc-doc-1', 'doc-doc-2']);
});
