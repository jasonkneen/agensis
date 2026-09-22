import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocuments } from '../../src/hooks/useDocuments';
import { useTasks } from '../../src/hooks/useTasks';
import type { Document, Task } from '../../src/types';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  authOwner: 'account-A',
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  cachedFetch: vi.fn(),
  offlineDelete: vi.fn(),
  offlineInsert: vi.fn(),
  offlineUpdate: vi.fn(),
  bodyRead: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { error: mocks.toastError, dismiss: mocks.toastDismiss } }));

vi.mock('../../src/hooks/useTableSubscription', () => ({
  useTableSubscription: vi.fn(),
  useRealtimeDeduper: () => ({ shouldProcess: () => true }),
}));
vi.mock('../../src/lib/backendClient', () => ({
  apiAuthHeaders: () => ({ Authorization: `Bearer ${mocks.authOwner}` }),
  backendClient: { from: () => {
    const filters: Record<string, string> = {};
    const query = { select: () => query, eq: (key: string, value: string) => { filters[key] = value; return query; },
      abortSignal: (signal: AbortSignal) => mocks.bodyRead(signal, filters) };
    return query;
  } },
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
  mocks.toastError.mockReset();
  mocks.toastDismiss.mockReset();
  mocks.cachedFetch.mockReset();
  mocks.offlineDelete.mockReset();
  mocks.offlineInsert.mockReset();
  mocks.offlineUpdate.mockReset();
  mocks.bodyRead.mockReset();
  mocks.bodyRead.mockResolvedValue({ data: [{ id: 'doc-a', content: 'body' }], error: null });
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


describe('document save recovery', () => {
  async function mount() {
    await act(async () => {
      root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] }));
      await settle();
    });
  }
  it('offers retry for a refused save and retains the exact failed draft', async () => {
    await mount();
    mocks.offlineUpdate.mockResolvedValueOnce(null);
    await act(async () => { await latestDocuments.saveDocument('doc-a', { content: '<p>unsaved draft</p>' }); });
    expect(mocks.toastError).toHaveBeenCalledWith('Document changes were not saved', expect.objectContaining({ duration: Infinity }));
    const options = mocks.toastError.mock.calls[0][1];
    mocks.offlineUpdate.mockResolvedValueOnce({ ...doc('doc-a'), content: '<p>unsaved draft</p>' });
    await act(async () => { options.action.onClick(); await settle(); });
    expect(mocks.offlineUpdate).toHaveBeenLastCalledWith('documents', 'doc-a', expect.objectContaining({ content: '<p>unsaved draft</p>' }), 'documents_meta_workspace-1');
    expect(mocks.toastDismiss).toHaveBeenCalledWith(options.id);
  });
  it('invalidates a failed draft retry as soon as a newer edit is scheduled', async () => {
    await mount(); mocks.offlineUpdate.mockResolvedValueOnce(null);
    await act(async () => { await latestDocuments.saveDocument('doc-a', { content: 'old draft' }); });
    const retry = mocks.toastError.mock.calls[0][1].action.onClick;
    act(() => latestDocuments.autoSave('doc-a', { content: 'new draft' }));
    retry();
    expect(mocks.offlineUpdate).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(800); await settle(); });
    expect(mocks.offlineUpdate).toHaveBeenLastCalledWith('documents', 'doc-a', expect.objectContaining({ content: 'new draft' }), 'documents_meta_workspace-1');
  });
  it('handles storage exceptions and refuses a retry under another account', async () => {
    await mount(); mocks.offlineUpdate.mockRejectedValueOnce(new Error('Quota exceeded'));
    await act(async () => { await latestDocuments.saveDocument('doc-a', { content: 'private draft' }); });
    const retry = mocks.toastError.mock.calls[0][1].action.onClick;
    mocks.authOwner = 'account-B'; retry();
    expect(mocks.offlineUpdate).toHaveBeenCalledTimes(1);
  });
});

it('does not pre-dismiss a future failure notice and gives each retry its own identity', async () => {
  await act(async () => { root.render(createElement(DocumentsProbe, { seed: [doc('doc-a')] })); await settle(); });
  mocks.offlineUpdate.mockResolvedValue(null);
  act(() => latestDocuments.autoSave('doc-a', { content: 'draft' }));
  expect(mocks.toastDismiss).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(800); await settle(); });
  const first = mocks.toastError.mock.calls[0][1];
  await act(async () => { first.action.onClick(); await settle(); });
  const second = mocks.toastError.mock.calls[1][1];
  expect(second.id).not.toBe(first.id);
  expect(mocks.toastDismiss).toHaveBeenCalledWith(first.id);
});


describe('document body read ownership', () => {
  async function mount(workspaceId = 'workspace-1') {
    await act(async () => { root.render(createElement(DocumentsProbe, { seed: [], workspaceId })); await settle(); });
  }
  it('shares pending reads and does not retain failed reads as empty documents', async () => {
    await mount();
    let resolve!: (value: unknown) => void;
    mocks.bodyRead.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const first = latestDocuments.fetchDocumentContent('doc-a');
    const second = latestDocuments.fetchDocumentContent('doc-a');
    expect(mocks.bodyRead).toHaveBeenCalledTimes(1);
    const failures = Promise.allSettled([first, second]);
    resolve({ data: null, error: { message: 'failed' } });
    expect((await failures).map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(await latestDocuments.fetchDocumentContent('doc-a')).toBe('body');
    expect(mocks.bodyRead).toHaveBeenCalledTimes(2);
    expect(mocks.bodyRead.mock.calls[1][1]).toEqual({ id: 'doc-a', workspace_id: 'workspace-1' });
  });
  it('aborts and discards a late response after switching workspaces', async () => {
    await mount();
    let resolve!: (value: unknown) => void;
    mocks.bodyRead.mockReturnValueOnce(new Promise(r => { resolve = r; }));
    const oldFetch = latestDocuments.fetchDocumentContent;
    const pending = oldFetch('doc-a');
    await mount('workspace-2');
    expect(mocks.bodyRead.mock.calls[0][0].aborted).toBe(true);
    resolve({ data: [{ id: 'doc-a', content: 'old workspace' }], error: null });
    expect(await pending).toBe('');
    expect(await oldFetch('doc-a')).toBe('');
    expect(await latestDocuments.fetchDocumentContent('doc-a')).toBe('body');
  });
  it('cannot serve cached bodies after an account change, even before rerender', async () => {
    await mount(); expect(await latestDocuments.fetchDocumentContent('doc-a')).toBe('body');
    mocks.authOwner = 'account-B';
    expect(await latestDocuments.fetchDocumentContent('doc-a')).toBe('');
    await mount();
    mocks.bodyRead.mockResolvedValueOnce({ data: [{ id: 'doc-a', content: 'new account' }], error: null });
    expect(await latestDocuments.fetchDocumentContent('doc-a')).toBe('new account');
  });
  it('a forced refresh supersedes a pending read without blanking its other consumers', async () => {
    await mount();
    let resolveOld!: (value: unknown) => void;
    let resolveNew!: (value: unknown) => void;
    mocks.bodyRead.mockReturnValueOnce(new Promise(r => { resolveOld = r; }));
    mocks.bodyRead.mockReturnValueOnce(new Promise(r => { resolveNew = r; }));
    const old = latestDocuments.fetchDocumentContent('doc-a');
    const refreshed = latestDocuments.fetchDocumentContent('doc-a', true);
    resolveOld({ data: [{ content: 'old' }], error: null });
    resolveNew({ data: [{ content: 'new' }], error: null });
    expect(await old).toBe('new'); expect(await refreshed).toBe('new');
    expect(await latestDocuments.fetchDocumentContent('doc-a')).toBe('new');
  });
});


it('serializes saves of one document while allowing other documents to save', async () => {
  await act(async () => { root.render(createElement(DocumentsProbe, { seed: [] })); await settle(); });
  let resolveFirst!: (value: Record<string, unknown>) => void;
  mocks.offlineUpdate.mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve; }));
  const first = latestDocuments.saveDocument('doc-a', { content: 'first' });
  const second = latestDocuments.saveDocument('doc-a', { content: 'second' });
  await act(async () => { await latestDocuments.saveDocument('doc-b', { content: 'independent' }); });
  expect(mocks.offlineUpdate.mock.calls.map(call => call[1])).toEqual(['doc-a', 'doc-b']);
  await act(async () => { resolveFirst({ ...doc('doc-a'), content: 'first' }); await Promise.all([first, second]); });
  expect(mocks.offlineUpdate.mock.calls.map(call => call[2].content)).toEqual(['first', 'independent', 'second']);
});

it('continues queued saves after a failure but drops them after an account switch', async () => {
  await act(async () => { root.render(createElement(DocumentsProbe, { seed: [] })); await settle(); });
  let rejectFirst!: (error: Error) => void;
  mocks.offlineUpdate.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectFirst = reject; }));
  const first = latestDocuments.saveDocument('doc-a', { content: 'first' });
  const second = latestDocuments.saveDocument('doc-a', { content: 'second' });
  await act(async () => { rejectFirst(new Error('failed')); await Promise.all([first, second]); });
  expect(mocks.offlineUpdate).toHaveBeenCalledTimes(2);
  let resolveThird!: (value: null) => void;
  mocks.offlineUpdate.mockReturnValueOnce(new Promise(resolve => { resolveThird = resolve; }));
  const third = latestDocuments.saveDocument('doc-a', { content: 'third' });
  const fourth = latestDocuments.saveDocument('doc-a', { content: 'fourth' });
  mocks.authOwner = 'account-B';
  await act(async () => { resolveThird(null); await Promise.all([third, fourth]); });
  expect(mocks.offlineUpdate).toHaveBeenCalledTimes(3);
});

it('creates attachment-free tasks with an empty array matching the database constraint', async () => {
  await act(async () => { root.render(createElement(TasksProbe, { seed: [] })); await settle(); });
  mocks.offlineInsert.mockResolvedValue(task('new-task'));
  await act(async () => { await latestTasks.createTask({ title: 'No attachments', attachments: null }); });
  expect(mocks.offlineInsert).toHaveBeenCalledWith('tasks', expect.objectContaining({ attachments: [] }), 'tasks_workspace-1');
});

it.each(['null', 'throw'])('reports failed task updates and deletion without changing the task (%s)', async failure => {
  const original = task('task-a');
  mocks.cachedFetch.mockResolvedValue([original]);
  await act(async () => { root.render(createElement(TasksProbe, { seed: [original] })); await settle(); });
  if (failure === 'throw') {
    mocks.offlineUpdate.mockRejectedValue(new Error('storage unavailable'));
    mocks.offlineDelete.mockRejectedValue(new Error('storage unavailable'));
  } else {
    mocks.offlineUpdate.mockResolvedValue(null);
    mocks.offlineDelete.mockResolvedValue(false);
  }
  await act(async () => {
    expect(await latestTasks.updateTask('task-a', { status: 'done' })).toBeNull();
    expect(await latestTasks.deleteTask('task-a')).toBe(false);
  });
  expect(latestTasks.tasks).toEqual([original]);
  expect(mocks.toastError).toHaveBeenCalledWith('Task changes were not saved', expect.any(Object));
  expect(mocks.toastError).toHaveBeenCalledWith('Task could not be deleted', expect.any(Object));
  mocks.offlineUpdate.mockResolvedValue({ ...original, status: 'done' });
  await act(async () => { await latestTasks.updateTask('task-a', { status: 'done' }); });
  expect(latestTasks.tasks[0].status).toBe('done');
  expect(mocks.toastError).toHaveBeenCalledTimes(2);
});
