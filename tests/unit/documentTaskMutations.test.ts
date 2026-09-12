import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocuments } from '../../src/hooks/useDocuments';
import { useTasks } from '../../src/hooks/useTasks';
import type { Document, Task } from '../../src/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  authOwner: 'account-A',
  cachedFetch: vi.fn(),
  offlineDelete: vi.fn(),
  offlineInsert: vi.fn(),
  offlineUpdate: vi.fn(),
}));

vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: vi.fn(),
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));
vi.mock('../../src/lib/backendClient', () => ({
  apiAuthHeaders: () => ({ Authorization: `Bearer ${mocks.authOwner}` }),
  backendClient: { from: vi.fn() },
}));
vi.mock('../../src/lib/offlineBackend', () => mocks);

const doc = (id: string): Document => ({
  id,
  workspace_id: 'workspace-1',
  title: id,
  content: `<p>${id}</p>`,
  is_favorite: false,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

const task = (id: string): Task => ({
  id,
  workspace_id: 'workspace-1',
  created_by: null,
  assignee_id: null,
  parent_id: null,
  title: id,
  description: '',
  status: 'todo',
  priority: 'normal',
  due_date: null,
  start_date: null,
  source_type: 'manual',
  source_id: null,
  completed_at: null,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
});

let root: Root;
let container: HTMLDivElement;
let latestDocuments: ReturnType<typeof useDocuments>;
let latestTasks: ReturnType<typeof useTasks>;

function DocumentsProbe({ seed, workspaceId = 'workspace-1' }: { seed: Document[]; workspaceId?: string }) {
  latestDocuments = useDocuments(workspaceId, seed);
  return null;
}

function TasksProbe({ seed }: { seed: Task[] }) {
  latestTasks = useTasks('workspace-1', undefined, seed);
  return null;
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.authOwner = 'account-A';
  mocks.cachedFetch.mockReset();
  mocks.offlineDelete.mockReset();
  mocks.offlineInsert.mockReset();
  mocks.offlineUpdate.mockReset();
  mocks.cachedFetch.mockResolvedValue([]);
  mocks.offlineDelete.mockResolvedValue(true);
  mocks.offlineInsert.mockResolvedValue(null);
  mocks.offlineUpdate.mockImplementation(async (_table: string, id: string, updates: Record<string, unknown>) => ({
    id,
    workspace_id: 'workspace-1',
    ...updates,
  }));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('document and task mutations', () => {
  it('persists attachment references when creating a task', async () => {
    const attachments = [{ id: 'file-1', name: 'brief.pdf', type: 'application/pdf', size: 42 }];
    mocks.offlineInsert.mockResolvedValue({ ...task('task-new'), attachments });
    await act(async () => {
      root.render(createElement(TasksProbe, { seed: [] }));
      await settle();
    });

    await act(async () => {
      await latestTasks.createTask({ title: 'Review brief', attachments });
    });

    expect(mocks.offlineInsert).toHaveBeenCalledWith(
      'tasks',
      expect.objectContaining({ title: 'Review brief', attachments }),
      'tasks_workspace-1',
    );
  });

  it('debounces each document independently and merges its pending fields', async () => {
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a'), doc('doc-b')] }));
      await settle();
    });

    act(() => {
      latestDocuments.autoSave('doc-a', { title: 'A revised' });
      latestDocuments.autoSave('doc-b', { content: '<p>B revised</p>' });
      latestDocuments.autoSave('doc-a', { content: '<p>A revised</p>' });
      vi.advanceTimersByTime(799);
    });
    expect(mocks.offlineUpdate).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
      await settle();
    });

    expect(mocks.offlineUpdate).toHaveBeenCalledTimes(2);
    expect(mocks.offlineUpdate).toHaveBeenCalledWith(
      'documents', 'doc-a', expect.objectContaining({ title: 'A revised', content: '<p>A revised</p>' }),
      'documents_meta_workspace-1',
    );
    expect(mocks.offlineUpdate).toHaveBeenCalledWith(
      'documents', 'doc-b', expect.objectContaining({ content: '<p>B revised</p>' }),
      'documents_meta_workspace-1',
    );
  });

  it('deleting one document only cancels that document\'s pending save', async () => {
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a'), doc('doc-b')] }));
      await settle();
    });
    act(() => {
      latestDocuments.autoSave('doc-a', { content: '<p>pending A</p>' });
      latestDocuments.autoSave('doc-b', { content: '<p>pending B</p>' });
    });

    await act(async () => { expect(await latestDocuments.deleteDocument('doc-a')).toBe(true); });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await settle();
    });

    expect(mocks.offlineUpdate).toHaveBeenCalledTimes(1);
    expect(mocks.offlineUpdate).toHaveBeenCalledWith(
      'documents', 'doc-b', expect.objectContaining({ content: '<p>pending B</p>' }),
      'documents_meta_workspace-1',
    );
  });

  it('keeps a document and task row when the server rejects deletion', async () => {
    mocks.offlineDelete.mockResolvedValue(false);
    mocks.cachedFetch.mockImplementation((key: string) => {
      if (key.startsWith('documents_meta_')) return Promise.resolve([doc('doc-a')]);
      if (key.startsWith('tasks_')) return Promise.resolve([task('task-a')]);
      return Promise.resolve([]);
    });
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] }));
      await settle();
    });
    await act(async () => { expect(await latestDocuments.deleteDocument('doc-a')).toBe(false); });
    expect(latestDocuments.documents.map(row => row.id)).toEqual(['doc-a']);

    await act(async () => {
      root.render(createElement(TasksProbe, { seed: [task('task-a')] }));
      await settle();
    });
    await act(async () => { expect(await latestTasks.deleteTask('task-a')).toBe(false); });
    expect(latestTasks.tasks.map(row => row.id)).toEqual(['task-a']);
  });

  it('keeps a rejected document delete\'s pending edit queued', async () => {
    mocks.cachedFetch.mockResolvedValue([doc('doc-a')]);
    mocks.offlineDelete.mockResolvedValue(false);
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] }));
      await settle();
    });
    act(() => { latestDocuments.autoSave('doc-a', { content: '<p>still needs saving</p>' }); });

    await act(async () => { expect(await latestDocuments.deleteDocument('doc-a')).toBe(false); });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await settle();
    });
    expect(mocks.offlineUpdate).toHaveBeenCalledWith(
      'documents', 'doc-a', expect.objectContaining({ content: '<p>still needs saving</p>' }),
      'documents_meta_workspace-1',
    );
  });

  it('does not flush a pending edit after the authenticated account changes', async () => {
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] }));
      await settle();
    });
    act(() => { latestDocuments.autoSave('doc-a', { content: '<p>account A</p>' }); });
    mocks.authOwner = 'account-B';

    await act(async () => { root.unmount(); await settle(); });
    expect(mocks.offlineUpdate).not.toHaveBeenCalled();
  });

  it('rejects an old auto-save callback after the authenticated account changes', async () => {
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] }));
      await settle();
    });
    const oldAutoSave = latestDocuments.autoSave;
    mocks.authOwner = 'account-B';
    oldAutoSave('doc-a', { content: '<p>must stay with account A</p>' });

    await act(async () => {
      vi.advanceTimersByTime(800);
      await settle();
    });
    expect(mocks.offlineUpdate).not.toHaveBeenCalled();
  });

  it('flushes a pending edit when only the workspace changes under the same account', async () => {
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')], workspaceId: 'workspace-A' }));
      await settle();
    });
    act(() => { latestDocuments.autoSave('doc-a', { content: '<p>workspace A</p>' }); });

    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [], workspaceId: 'workspace-B' }));
      await settle();
    });
    expect(mocks.offlineUpdate).toHaveBeenCalledWith(
      'documents', 'doc-a', expect.objectContaining({ content: '<p>workspace A</p>' }),
      'documents_meta_workspace-A',
    );
  });

  it('does not let a newer edit get overwritten when a rejected delete restores an older one', async () => {
    mocks.cachedFetch.mockResolvedValue([doc('doc-a')]);
    mocks.offlineDelete.mockResolvedValue(false);
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] }));
      await settle();
    });
    act(() => { latestDocuments.autoSave('doc-a', { content: '<p>older edit</p>' }); });
    let resolveDelete!: (value: boolean) => void;
    mocks.offlineDelete.mockReturnValueOnce(new Promise<boolean>(resolve => { resolveDelete = resolve; }));
    const deletion = latestDocuments.deleteDocument('doc-a');
    // The newer edit is made while the delete request is still unresolved.
    act(() => { latestDocuments.autoSave('doc-a', { content: '<p>newer edit</p>' }); });
    await act(async () => { resolveDelete(false); await deletion; });
    await act(async () => {
      vi.advanceTimersByTime(800);
      await settle();
    });
    expect(mocks.offlineUpdate).toHaveBeenCalledWith(
      'documents', 'doc-a', expect.objectContaining({ content: '<p>newer edit</p>' }),
      'documents_meta_workspace-1',
    );
    expect(mocks.offlineUpdate).not.toHaveBeenCalledWith(
      'documents', 'doc-a', expect.objectContaining({ content: '<p>older edit</p>' }),
      'documents_meta_workspace-1',
    );
  });
});
