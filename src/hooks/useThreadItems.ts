import { useState, useEffect, useCallback, useMemo } from 'react';
import { backendClient } from '../lib/backendClient';
import { cachedFetch, offlineInsert, offlineUpdate, offlineDelete } from '../lib/offlineBackend';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import type { ThreadItem, ThreadItemKind, ThreadItemStatus } from '../types';

export interface CreateThreadItemInput {
  kind: ThreadItemKind;
  content: string;
  status?: ThreadItemStatus;
  order_index?: number;
  message_id?: string | null;
}

// Per-thread widget items (todo / plan / blocker) shown in the chat widget rail.
// Scoped to a single chat session so each thread has its own board. Realtime so
// items an agent creates appear live, and so two open windows stay in sync.
export function useThreadItems(
  workspaceId: string | null,
  sessionId: string | null,
  userId?: string,
) {
  const [items, setItems] = useState<ThreadItem[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchItems = useCallback(async () => {
    if (!workspaceId || !sessionId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const data = await cachedFetch<ThreadItem[]>(`thread_items_${sessionId}`, async () => {
      const { data } = await backendClient
        .from('thread_items')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('session_id', sessionId)
        .order('order_index', { ascending: true });
      return data;
    });
    if (data) setItems(data);
    setLoading(false);
  }, [workspaceId, sessionId]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const deduper = useRealtimeDeduper();
  useTableSubscription<ThreadItem>(
    {
      enabled: !!workspaceId && !!sessionId,
      channelName: `thread_items:${sessionId}`,
      table: 'thread_items',
      event: '*',
      schema: 'public',
      filter: `session_id=eq.${sessionId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      if (payload.eventType === 'INSERT') {
        const row = payload.new;
        if (!row) return;
        setItems(prev => prev.some(i => i.id === row.id) ? prev : [...prev, row]);
      } else if (payload.eventType === 'UPDATE') {
        const row = payload.new;
        if (!row) return;
        setItems(prev => prev.map(i => i.id === row.id ? row : i));
      } else if (payload.eventType === 'DELETE') {
        const row = payload.old;
        if (!row?.id) return;
        setItems(prev => prev.filter(i => i.id !== row.id));
      }
    },
  );

  const createItem = useCallback(async (input: CreateThreadItemInput) => {
    if (!workspaceId || !sessionId) return null;
    const kindItems = items.filter(i => i.kind === input.kind);
    const nextOrder = input.order_index ?? (kindItems.reduce((max, i) => Math.max(max, i.order_index), 0) + 1);
    const data = await offlineInsert('thread_items', {
      workspace_id: workspaceId,
      session_id: sessionId,
      created_by: userId ?? null,
      kind: input.kind,
      content: input.content,
      status: input.status ?? 'open',
      order_index: nextOrder,
      message_id: input.message_id ?? null,
    }, `thread_items_${sessionId}`);
    if (data) {
      const item = data as unknown as ThreadItem;
      setItems(prev => prev.some(i => i.id === item.id) ? prev : [...prev, item]);
      return item;
    }
    return null;
  }, [workspaceId, sessionId, userId, items]);

  const updateItem = useCallback(async (id: string, updates: Partial<ThreadItem>) => {
    const result = await offlineUpdate('thread_items', id, updates as Record<string, unknown>, `thread_items_${sessionId}`);
    if (result) {
      setItems(prev => prev.map(i => i.id === id ? { ...i, ...result } as ThreadItem : i));
    }
    return result;
    }, [sessionId]);

  const toggleDone = useCallback(async (item: ThreadItem) => {
    const next: ThreadItemStatus = item.status === 'done' ? 'open' : 'done';
    return updateItem(item.id, { status: next });
  }, [updateItem]);

  const answerBlocker = useCallback(async (item: ThreadItem, response: string) => {
    return updateItem(item.id, { status: 'answered', response });
  }, [updateItem]);

  const deleteItem = useCallback(async (id: string) => {
    await offlineDelete('thread_items', id, `thread_items_${sessionId}`);
    setItems(prev => prev.filter(i => i.id !== id));
    return true;
    }, [sessionId]);

  const byKind = useMemo(() => {
    const groups: Record<ThreadItemKind, ThreadItem[]> = { todo: [], plan: [], blocker: [] };
    for (const item of items) {
      (groups[item.kind] ?? groups.todo).push(item);
    }
    (Object.keys(groups) as ThreadItemKind[]).forEach(k =>
      groups[k].sort((a, b) => a.order_index - b.order_index));
    return groups;
  }, [items]);

  return {
    items,
    byKind,
    loading,
    createItem,
    updateItem,
    toggleDone,
    answerBlocker,
    deleteItem,
    refetch: fetchItems,
  };
}
