import { useState, useEffect, useCallback, useMemo } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import type { Task, TaskStatus, TaskPriority, TaskSourceType } from '../types';
import type { DbChangePayload } from '../types/realtime';

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
}

export function useTasks(workspaceId: string | null, userId?: string) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchTasks = useCallback(async () => {
    if (!workspaceId) {
      setTasks([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<Task[]>(`tasks_${workspaceId}`, async () => {
      const { data } = await backendClient
        .from('tasks')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false });
      return data;
    });
    if (data) setTasks(data);
    setLoading(false);
  }, [workspaceId]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useEffect(() => {
    if (!workspaceId) return;
    const channel = backendClient
      .channel(`tasks:${workspaceId}`)
      .on(
        'db_changes',
        { event: '*', schema: 'public', table: 'tasks', filter: `workspace_id=eq.${workspaceId}` },
        (payload: DbChangePayload<Task>) => {
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
      )
      .subscribe();
    return () => {
      backendClient.removeChannel(channel);
    };
  }, [workspaceId]);

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
    });
    if (data) {
      const task = data as unknown as Task;
      setTasks(prev => prev.some(t => t.id === task.id) ? prev : [task, ...prev]);
      return task;
    }
    return null;
  }, [workspaceId, userId]);

  const updateTask = useCallback(async (id: string, updates: Partial<Task>) => {
    const patch: Partial<Task> = { ...updates };
    if (updates.status === 'done' && !updates.completed_at) {
      patch.completed_at = new Date().toISOString();
    }
    if (updates.status && updates.status !== 'done') {
      patch.completed_at = null;
    }
    const result = await offlineUpdate('tasks', id, patch as Record<string, unknown>);
    if (result) {
      setTasks(prev => prev.map(t => t.id === id ? { ...t, ...result } as Task : t));
    }
    return result;
  }, []);

  const toggleTaskStatus = useCallback(async (task: Task) => {
    const next: TaskStatus = task.status === 'done' ? 'todo' : 'done';
    return updateTask(task.id, { status: next });
  }, [updateTask]);

  const deleteTask = useCallback(async (id: string) => {
    await offlineDelete('tasks', id);
    setTasks(prev => prev.filter(t => t.id !== id));
    return true;
  }, []);

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
