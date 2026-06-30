import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AgentRuntimeField } from '../../src/components/windows/AgentsWindowContent';
import type { WorkspaceAgent } from '../../src/types';

function agent(p: Partial<WorkspaceAgent> = {}): WorkspaceAgent {
  return {
    id: 'a1', workspace_id: 'ws-1', name: 'Coder', avatar: 'AI', description: '',
    system_prompt: '', model: 'auto', run_mode: 'external', runtime_id: null,
    created_by: null, created_at: '', updated_at: '', ...p,
  };
}

function routeFetch(routes: Array<{ test: RegExp; method?: string; payload: unknown }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = (init?.method || 'GET').toUpperCase();
    const hit = routes.find((r) => r.test.test(String(url)) && (!r.method || r.method === method));
    return { ok: true, status: 200, json: async () => hit?.payload ?? { data: null, error: null } } as unknown as Response;
  });
}

describe('AgentRuntimeField', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('offers approved runtimes and maps the agent on selection', async () => {
    const fetchMock = routeFetch([
      { test: /\/runtimes$/, method: 'GET', payload: { data: { runtimes: [
        { id: 'rt-1', name: 'Cursor', status: 'approved', online: true },
        { id: 'rt-2', name: 'Pending', status: 'pending' },
      ] }, error: null } },
      { test: /\/agents\/a1\/runtime$/, method: 'POST', payload: { data: { agent: { id: 'a1', runtime_id: 'rt-1' } }, error: null } },
    ]);
    vi.stubGlobal('fetch', fetchMock);

    render(<AgentRuntimeField agent={agent()} />);

    // Approved runtime appears as an option; pending one does not.
    expect(await screen.findByRole('option', { name: /Cursor/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Pending/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Backing runtime'), { target: { value: 'rt-1' } });

    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([u, i]) =>
        /\/agents\/a1\/runtime$/.test(String(u)) && (i as RequestInit)?.method === 'POST')).toBe(true);
    });
  });

  it('shows a hint when there are no approved runtimes', async () => {
    vi.stubGlobal('fetch', routeFetch([
      { test: /\/runtimes$/, method: 'GET', payload: { data: { runtimes: [] }, error: null } },
    ]));
    render(<AgentRuntimeField agent={agent()} />);
    expect(await screen.findByText(/No approved runtimes yet/i)).toBeInTheDocument();
  });
});
