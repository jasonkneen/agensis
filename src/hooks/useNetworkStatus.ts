import { useState, useEffect, useCallback, useRef } from 'react';
import { backendClient } from '../lib/backendClient';
import { peekQueue, dequeue, clearQueue as clearOfflineQueue } from '../lib/offlineDb';

export function useNetworkStatus() {
  const [online, setOnline] = useState(navigator.onLine);
  const [syncing, setSyncing] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [syncError, setSyncError] = useState<string | null>(null);
  const syncingRef = useRef(false);

  useEffect(() => {
    const goOnline = () => setOnline(true);
    const goOffline = () => setOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  const flushQueue = useCallback(async () => {
    if (syncingRef.current || !navigator.onLine) return;
    syncingRef.current = true;
    setSyncing(true);

    try {
      const items = (await peekQueue()).sort((a, b) => a.created_at - b.created_at);
      setPendingCount(items.length);

      if (items.length === 0) {
        setSyncError(null);
      }

      let failedCount = 0;

      for (const item of items) {
        try {
          if (item.operation === 'insert') {
            const { error } = await backendClient.from(item.table).insert(item.payload);
            if (error) throw error;
          } else if (item.operation === 'update') {
            const { id: rowId, ...rest } = item.payload as Record<string, unknown> & { id: string };
            const { error } = await backendClient.from(item.table).update(rest).eq('id', rowId);
            if (error) throw error;
          } else if (item.operation === 'delete') {
            const { error } = await backendClient.from(item.table).delete().eq('id', item.payload.id as string);
            if (error) throw error;
          }
          if (item.id != null) await dequeue(item.id);
          setPendingCount(prev => Math.max(0, prev - 1));
        } catch (error) {
          failedCount++;
          console.error('[offline-sync] Failed to flush queued change (skipping)', {
            table: item.table,
            operation: item.operation,
            payload: item.payload,
            error,
          });
          // Skip this item and continue processing remaining items so one
          // permanently-broken entry does not block the entire queue.
        }
      }

      if (failedCount > 0) {
        setSyncError(`${failedCount} queued change${failedCount === 1 ? '' : 's'} failed to sync`);
      } else {
        setSyncError(null);
      }
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      const remaining = await peekQueue();
      setPendingCount(remaining.length);
    }
  }, []);

  useEffect(() => {
    if (online) flushQueue();
  }, [online, flushQueue]);

  useEffect(() => {
    if (!online) return;
    const interval = setInterval(flushQueue, 30_000);
    return () => clearInterval(interval);
  }, [online, flushQueue]);

  const clearPendingQueue = useCallback(async () => {
    await clearOfflineQueue();
    setPendingCount(0);
    setSyncError(null);
  }, []);

  useEffect(() => {
    peekQueue().then(items => setPendingCount(items.length));
  }, []);

  return { online, syncing, pendingCount, syncError, flushQueue, clearPendingQueue };
}
