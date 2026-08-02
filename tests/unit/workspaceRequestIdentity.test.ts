import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentConnections } from '../../src/hooks/useAgentConnections';
import { useAgentRegistrations, type AgentRegistration } from '../../src/hooks/useAgentRegistrations';
import { useAgents } from '../../src/hooks/useAgents';
import { useChat } from '../../src/hooks/useChat';
import { useDocuments } from '../../src/hooks/useDocuments';
import { useFiles } from '../../src/hooks/useFiles';
import { useSharing } from '../../src/hooks/useSharing';
import { useTasks } from '../../src/hooks/useTasks';
import { useWorkspaceBootstrap } from '../../src/hooks/useWorkspaceBootstrap';
import type { AgentConnection } from '../../src/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const moduleMocks = vi.hoisted(() => ({
  cachedFetch: vi.fn(),
  from: vi.fn(),
}));

vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: vi.fn(),
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));
vi.mock('../../src/hooks/useSessionRevocationSignal', () => ({ useSessionRevocationSignal: vi.fn() }));
vi.mock('../../src/lib/backendClient', () => ({
  apiUrl: (path: string) => path,
  apiAuthHeaders: () => ({}),
  backendClient: { from: moduleMocks.from },
}));
vi.mock('../../src/lib/offlineBackend', () => ({
  cachedFetch: moduleMocks.cachedFetch,
  offlineDelete: vi.fn(),
  offlineInsert: vi.fn(),
  offlineInsertResult: vi.fn(),
  offlineMessageSendResult: vi.fn(),
  offlineUpdate: vi.fn(),
  redactCachedSessionMessages: vi.fn(async () => {}),
}));

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
function response(data: unknown): Response {
  return { ok: true, json: async () => ({ data }) } as Response;
}

let root: Root;
let container: HTMLDivElement;
let latestConnections: ReturnType<typeof useAgentConnections>;
let latestRegistrations: ReturnType<typeof useAgentRegistrations>;
let latestBootstrap: ReturnType<typeof useWorkspaceBootstrap>;
let latestSharing: ReturnType<typeof useSharing>;
let latestFiles: ReturnType<typeof useFiles>;
let listLoadingRenders: boolean[][] = [];
let latestLists: {
  documentIds: string[];
  taskIds: string[];
  agentIds: string[];
  sessionIds: string[];
  fileIds: string[];
  loading: boolean[];
};

function ConnectionsProbe({ workspaceId }: { workspaceId: string | null }) {
  latestConnections = useAgentConnections(workspaceId);
  return null;
}
function RegistrationsProbe({ workspaceId }: { workspaceId: string | null }) {
  latestRegistrations = useAgentRegistrations(workspaceId);
  return null;
}
function BootstrapProbe({ workspaceId }: { workspaceId: string | null }) {
  latestBootstrap = useWorkspaceBootstrap(workspaceId);
  return null;
}
function SharingProbe({ workspaceId }: { workspaceId: string | null }) {
  latestSharing = useSharing(workspaceId, 'current-user');
  return null;
}
function FilesProbe({ workspaceId, seed }: { workspaceId: string; seed: Parameters<typeof useFiles>[1] }) {
  latestFiles = useFiles(workspaceId, seed);
  return null;
}
function ListsProbe({ workspaceId }: { workspaceId: string | null }) {
  const documents = useDocuments(workspaceId);
  const tasks = useTasks(workspaceId);
  const agents = useAgents(workspaceId);
  const chat = useChat(workspaceId);
  const files = useFiles(workspaceId);
  latestLists = {
    documentIds: documents.documents.map(row => row.id),
    taskIds: tasks.tasks.map(row => row.id),
    agentIds: agents.agents.map(row => row.id),
    sessionIds: chat.sessions.map(row => row.id),
    fileIds: files.files.map(row => row.id),
    loading: [documents.loading, tasks.loading, agents.loading, files.loading],
  };
  listLoadingRenders.push(latestLists.loading);
  return null;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  moduleMocks.cachedFetch.mockReset();
  moduleMocks.from.mockReset();
  listLoadingRenders = [];
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('workspace request identity', () => {
  it('keeps workspace B connections and loading when workspace A resolves last', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
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
    const a = deferred<Response>();
    const b = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/A/') ? a.promise : b.promise));
    act(() => root.render(createElement(RegistrationsProbe, { workspaceId: 'A' })));
    act(() => root.render(createElement(RegistrationsProbe, { workspaceId: 'B' })));
    const bRow = { id: 'b', workspace_id: 'B', status: 'pending' } as AgentRegistration;
    await act(async () => { b.resolve(response({ registrations: [bRow] })); await b.promise; });
    expect(latestRegistrations.pending.map(row => row.id)).toEqual(['b']);
    await act(async () => { a.resolve(response({ registrations: [{ ...bRow, id: 'a', workspace_id: 'A' }] })); await a.promise; });
    expect(latestRegistrations.pending.map(row => row.id)).toEqual(['b']);
  });

  it('stops exposing an old bootstrap snapshot as soon as the workspace changes', async () => {
    const a = deferred<Response>();
    const b = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn((url: string) => url.includes('/A/') ? a.promise : b.promise));

    act(() => root.render(createElement(BootstrapProbe, { workspaceId: 'A' })));
    await act(async () => {
      a.resolve(response({ workspace: { id: 'A' }, agents: [], sessions: [], documents: [], tasks: [], files: [], connections: [], memoryFacts: [] }));
      await a.promise;
    });
    expect(latestBootstrap.data?.workspace?.id).toBe('A');

    act(() => root.render(createElement(BootstrapProbe, { workspaceId: 'B' })));
    expect(latestBootstrap.data).toBeNull();
    expect(latestBootstrap.loading).toBe(true);

    await act(async () => {
      b.resolve(response({ workspace: { id: 'B' }, agents: [], sessions: [], documents: [], tasks: [], files: [], connections: [], memoryFacts: [] }));
      await b.promise;
    });
    expect(latestBootstrap.data?.workspace?.id).toBe('B');
  });

  it('keeps all primary workspace B lists when workspace A refreshes resolve last', async () => {
    const requests = new Map<string, Deferred<unknown>>();
    moduleMocks.cachedFetch.mockImplementation((key: string) => {
      if (key.startsWith('messages_page_')) return Promise.resolve({ messages: [], hasMore: false });
      const request = deferred<unknown>();
      requests.set(key, request);
      return request.promise;
    });

    act(() => root.render(createElement(ListsProbe, { workspaceId: 'A' })));
    act(() => root.render(createElement(ListsProbe, { workspaceId: 'B' })));

    const rows = (workspaceId: string) => ({
      documents: [{ id: `document-${workspaceId}`, workspace_id: workspaceId, title: workspaceId, is_favorite: false, created_at: '', updated_at: '' }],
      tasks: [{ id: `task-${workspaceId}`, workspace_id: workspaceId, title: workspaceId }],
      agents: [{ id: `agent-${workspaceId}`, workspace_id: workspaceId, name: workspaceId }],
      sessions: [{ id: `session-${workspaceId}`, workspace_id: workspaceId, title: workspaceId, model: 'auto', created_at: '', updated_at: '' }],
      files: [{ id: `file-${workspaceId}`, workspace_id: workspaceId, name: workspaceId, size: 1, type: 'text/plain', storage_path: '', created_at: '' }],
    });
    const b = rows('B');
    await act(async () => {
      requests.get('documents_meta_B')?.resolve(b.documents);
      requests.get('tasks_B')?.resolve(b.tasks);
      requests.get('agents_B')?.resolve(b.agents);
      requests.get('sessions_B')?.resolve(b.sessions);
      requests.get('files_B')?.resolve(b.files);
      await settle();
    });
    expect(latestLists).toEqual({
      documentIds: ['document-B'],
      taskIds: ['task-B'],
      agentIds: ['agent-B'],
      sessionIds: ['session-B'],
      fileIds: ['file-B'],
      loading: [false, false, false, false],
    });

    const a = rows('A');
    await act(async () => {
      requests.get('documents_meta_A')?.resolve(a.documents);
      requests.get('tasks_A')?.resolve(a.tasks);
      requests.get('agents_A')?.resolve(a.agents);
      requests.get('sessions_A')?.resolve(a.sessions);
      requests.get('files_A')?.resolve(a.files);
      await settle();
    });
    expect(latestLists).toEqual({
      documentIds: ['document-B'],
      taskIds: ['task-B'],
      agentIds: ['agent-B'],
      sessionIds: ['session-B'],
      fileIds: ['file-B'],
      loading: [false, false, false, false],
    });
  });

  it('marks workspace lists loading during the first render after a workspace switch', async () => {
    moduleMocks.cachedFetch.mockImplementation((key: string) => {
      if (key.startsWith('messages_page_')) return Promise.resolve({ messages: [], hasMore: false });
      const workspaceId = key.endsWith('_A') ? 'A' : 'B';
      if (workspaceId === 'B') return new Promise(() => {});
      if (key.startsWith('documents_meta_')) return Promise.resolve([{ id: 'document-A', workspace_id: 'A' }]);
      if (key.startsWith('tasks_')) return Promise.resolve([{ id: 'task-A', workspace_id: 'A' }]);
      if (key.startsWith('agents_')) return Promise.resolve([{ id: 'agent-A', workspace_id: 'A' }]);
      if (key.startsWith('sessions_')) return Promise.resolve([]);
      return Promise.resolve([{ id: 'file-A', workspace_id: 'A', size: 1 }]);
    });

    act(() => root.render(createElement(ListsProbe, { workspaceId: 'A' })));
    await act(settle);
    expect(latestLists.loading).toEqual([false, false, false, false]);

    listLoadingRenders = [];
    act(() => root.render(createElement(ListsProbe, { workspaceId: 'B' })));
    expect(listLoadingRenders[0]).toEqual([true, true, true, true]);
  });

  it('uses the current workspace setter when deleting a file after a switch', async () => {
    const file = (workspaceId: string) => ({
      id: `file-${workspaceId}`,
      workspace_id: workspaceId,
      name: workspaceId,
      size: 1,
      type: 'text/plain',
      storage_path: '',
      created_at: '',
    });
    moduleMocks.cachedFetch.mockImplementation((key: string) => Promise.resolve([
      file(key.endsWith('_A') ? 'A' : 'B'),
    ]));
    vi.stubGlobal('fetch', vi.fn(async () => response({ deleted: true })));

    act(() => root.render(createElement(FilesProbe, { workspaceId: 'A', seed: [file('A')] })));
    await act(settle);
    act(() => root.render(createElement(FilesProbe, { workspaceId: 'B', seed: [file('B')] })));
    await act(settle);
    expect(latestFiles.files.map(row => row.id)).toEqual(['file-B']);

    await act(async () => { await latestFiles.deleteFile('file-B'); });
    expect(latestFiles.files).toEqual([]);
  });

  it('keeps workspace B sharing state when workspace A requests resolve last', async () => {
    const members = new Map([
      ['A', deferred<{ data: unknown[] }>()],
      ['B', deferred<{ data: unknown[] }>()],
    ]);
    const settings = new Map([
      ['A', deferred<{ data: { auto_share: boolean } }>()],
      ['B', deferred<{ data: { auto_share: boolean } }>()],
    ]);
    moduleMocks.from.mockImplementation((table: string) => {
      let workspaceId = '';
      const query = {
        select: () => query,
        eq: (_column: string, value: string) => { workspaceId = value; return query; },
        order: () => members.get(workspaceId)?.promise,
        maybeSingle: () => settings.get(workspaceId)?.promise,
      };
      if (table !== 'workspace_members' && table !== 'workspaces') throw new Error(`Unexpected table ${table}`);
      return query;
    });

    act(() => root.render(createElement(SharingProbe, { workspaceId: 'A' })));
    act(() => root.render(createElement(SharingProbe, { workspaceId: 'B' })));
    await act(async () => {
      members.get('B')?.resolve({ data: [{ id: 'member-B', workspace_id: 'B' }] });
      settings.get('B')?.resolve({ data: { auto_share: true } });
      await settle();
    });
    expect(latestSharing.members.map(row => row.id)).toEqual(['member-B']);
    expect(latestSharing.autoShare).toBe(true);

    await act(async () => {
      members.get('A')?.resolve({ data: [{ id: 'member-A', workspace_id: 'A' }] });
      settings.get('A')?.resolve({ data: { auto_share: false } });
      await settle();
    });
    expect(latestSharing.members.map(row => row.id)).toEqual(['member-B']);
    expect(latestSharing.autoShare).toBe(true);
  });

  it('does not roll a failed workspace A auto-share mutation back over workspace B', async () => {
    const updateA = deferred<{ error: { message: string } }>();
    moduleMocks.from.mockImplementation((table: string) => {
      let operation: 'select' | 'update' = 'select';
      let workspaceId = '';
      const query = {
        select: () => query,
        update: () => { operation = 'update'; return query; },
        eq: (_column: string, value: string) => { workspaceId = value; return query; },
        order: () => Promise.resolve({ data: [] }),
        maybeSingle: () => Promise.resolve({ data: { auto_share: workspaceId === 'B' } }),
        then: (resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
          const result = operation === 'update' && workspaceId === 'A'
            ? updateA.promise
            : Promise.resolve({ error: null });
          return result.then(resolve, reject);
        },
      };
      if (table !== 'workspace_members' && table !== 'workspaces') throw new Error(`Unexpected table ${table}`);
      return query;
    });

    act(() => root.render(createElement(SharingProbe, { workspaceId: 'A' })));
    await act(settle);
    let toggle!: Promise<void>;
    act(() => { toggle = latestSharing.toggleAutoShare(); });
    act(() => root.render(createElement(SharingProbe, { workspaceId: 'B' })));
    await act(settle);
    expect(latestSharing.autoShare).toBe(true);

    await act(async () => {
      updateA.resolve({ error: { message: 'failed' } });
      await toggle;
    });
    expect(latestSharing.autoShare).toBe(true);
  });
});
