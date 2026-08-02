import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentConnections } from '../../src/hooks/useAgentConnections';
import { useAgentRegistrations, type AgentRegistration } from '../../src/hooks/useAgentRegistrations';
import type { AgentConnection } from '../../src/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: vi.fn(),
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));
vi.mock('../../src/lib/backendClient', () => ({ apiUrl: (path: string) => path, apiAuthHeaders: () => ({}) }));

type Deferred = { promise: Promise<Response>; resolve: (response: Response) => void };
function deferred(): Deferred {
  let resolve!: (response: Response) => void;
  return { promise: new Promise<Response>((done) => { resolve = done; }), resolve };
}
function response(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

let root: Root;
let container: HTMLDivElement;
let latestConnections: ReturnType<typeof useAgentConnections>;
let latestRegistrations: ReturnType<typeof useAgentRegistrations>;

function ConnectionsProbe({ workspaceId }: { workspaceId: string | null }) {
  latestConnections = useAgentConnections(workspaceId);
  return null;
}
function RegistrationsProbe({ workspaceId }: { workspaceId: string | null }) {
  latestRegistrations = useAgentRegistrations(workspaceId);
  return null;
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('workspace request identity', () => {
  it('keeps workspace B connections and loading when workspace A resolves last', async () => {
    const a = deferred();
    const b = deferred();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('workspaceId=A') ? a.promise : b.promise));
    act(() => root.render(createElement(ConnectionsProbe, { workspaceId: 'A' })));
    act(() => root.render(createElement(ConnectionsProbe, { workspaceId: 'B' })));
    const bRow = { id: 'b', workspace_id: 'B', status: 'online', last_seen_at: new Date().toISOString() } as AgentConnection;
    await act(async () => { a.resolve(response([{ ...bRow, id: 'a', workspace_id: 'A' }])); await a.promise; });
    expect(latestConnections.connections.map(row => row.id)).toEqual([]);
    expect(latestConnections.loading).toBe(true);
    await act(async () => { b.resolve(response([bRow])); await b.promise; });
    expect(latestConnections.connections.map(row => row.id)).toEqual(['b']);
    expect(latestConnections.loading).toBe(false);
  });

  it('keeps workspace B registrations when workspace A refresh resolves last', async () => {
    const a = deferred();
    const b = deferred();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/A/') ? a.promise : b.promise));
    act(() => root.render(createElement(RegistrationsProbe, { workspaceId: 'A' })));
    act(() => root.render(createElement(RegistrationsProbe, { workspaceId: 'B' })));
    const bRow = { id: 'b', workspace_id: 'B', status: 'pending' } as AgentRegistration;
    await act(async () => { b.resolve(response({ registrations: [bRow] })); await b.promise; });
    expect(latestRegistrations.pending.map(row => row.id)).toEqual(['b']);
    await act(async () => { a.resolve(response({ registrations: [{ ...bRow, id: 'a', workspace_id: 'A' }] })); await a.promise; });
    expect(latestRegistrations.pending.map(row => row.id)).toEqual(['b']);
  });
});
