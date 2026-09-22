import { useEffect, useCallback, useMemo } from 'react';
import { toast } from 'sonner';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';
import type { MessageAttachment, Task, TaskStatus, TaskPriority, TaskSourceType } from '../types';

export interface CreateTaskInput {
  title: string;
  description?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string | null;
  assignee_id?: string | null;
  parent_id?: string | null;
  source_type?: TaskSourceType;
  source_id?: string | null;
  attachments?: MessageAttachment[] | null;
}

export function useTasks(workspaceId: string | null, userId?: string, seed?: Task[] | null) {
  const [tasks, setTasks, beginTasksRequest] = useWorkspaceListState<Task>(
    workspaceId,
    (seed || []).filter(task => task.workspace_id === workspaceId),
  );
  const [loading, setLoading] = useWorkspaceState(
    workspaceId,
    !seed?.length,
    Boolean(workspaceId),
  );

  useEffect(() => {
    if (seed) setTasks(seed.filter(task => task.workspace_id === workspaceId));
  }, [seed, setTasks, workspaceId]);

  const fetchTasks = useCallback(async () => {
    const isCurrent = beginTasksRequest();
    if (!workspaceId) {
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const data = await cachedFetch<Task[]>(`tasks_${workspaceId}`, async () => {
        const { data } = await backendClient
          .from('tasks')
          .select('*')
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: false });
        return data;
      });
      if (isCurrent() && data) setTasks(data);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginTasksRequest, setLoading, setTasks, workspaceId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<Task>(
    {
      enabled: !!workspaceId,
      channelName: `tasks:${workspaceId}`,
      table: 'tasks',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        setTasks(prev => prev.some(t => t.id === row.id) ? prev : [row, ...prev]);
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setTasks(prev => prev.map(t => t.id === row.id ? row : t));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setTasks(prev => prev.filter(t => t.id !== row.id));
      }
    },
  );

  const createTask = useCallback(async (input: CreateTaskInput) => {
    if (!workspaceId) return null;
    const data = await offlineInsert('tasks', {
      workspace_id: workspaceId,
      created_by: userId ?? null,
      assignee_id: input.assignee_id ?? null,
      parent_id: input.parent_id ?? null,
      title: input.title,
      description: input.description ?? '',
      status: input.status ?? 'todo',
      priority: input.priority ?? 'normal',
      due_date: input.due_date ?? null,
      source_type: input.source_type ?? 'manual',
      source_id: input.source_id ?? null,
      attachments: input.attachments ?? [],
    }, `tasks_${workspaceId}`);
    if (data) {
      const task = data as unknown as Task;
      setTasks(prev => prev.some(t => t.id === task.id) ? prev : [task, ...prev]);
      return task;
    }
    return null;
  }, [setTasks, workspaceId, userId]);

  const updateTask = useCallback(async (id: string, updates: Partial<Task>) => {
    const patch: Partial<Task> = { ...updates };
    if (updates.status === 'done' && !updates.completed_at) {
      patch.completed_at = new Date().toISOString();
    }
    if (updates.status && updates.status !== 'done') {
      patch.completed_at = null;
    }
    let result: Record<string, unknown> | null = null;
    try {
      result = await offlineUpdate('tasks', id, patch as Record<string, unknown>, `tasks_${workspaceId}`);
    } catch {
      // Local queue persistence can fail as well as the HTTP request.
    }
    if (result) {
      setTasks(prev => prev.map(t => t.id === id ? { ...t, ...result } as Task : t));
    } else {
      toast.error('Task changes were not saved', {
        description: 'Try the change again before closing this task.',
      });
    }
    return result;
  }, [setTasks, workspaceId]);

  const toggleTaskStatus = useCallback(async (task: Task) => {
    const next: TaskStatus = task.status === 'done' ? 'todo' : 'done';
    return updateTask(task.id, { status: next });
  }, [updateTask]);

  const deleteTask = useCallback(async (id: string) => {
    let deleted = false;
    try {
      deleted = await offlineDelete('tasks', id, `tasks_${workspaceId}`);
    } catch {
      // Keep the task visible if deletion could not be persisted.
    }
    if (!deleted) {
      toast.error('Task could not be deleted', { description: 'The task is still available. Try again.' });
      return false;
    }
    setTasks(prev => prev.filter(t => t.id !== id));
    return true;
  }, [setTasks, workspaceId]);

  const openTasks = useMemo(() => tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled'), [tasks]);
  const doneTasks = useMemo(() => tasks.filter(t => t.status === 'done'), [tasks]);

  return {
    tasks,
    openTasks,
    doneTasks,
    loading,
    createTask,
    updateTask,
    toggleTaskStatus,
    deleteTask,
    refetch: fetchTasks,
  };
}
