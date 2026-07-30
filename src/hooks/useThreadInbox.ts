import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { sortThreadInbox, threadInboxBadgeCount, type ThreadInboxItem } from '../lib/threadInbox';

// ---------------------------------------------------------------------------
// The sidebar's Threads section — message threads this person follows.
//
// Read state reuses the INBOX's marker table and its /backend/inbox/read route
// rather than a second read model. Two models would eventually disagree about
// what "read" means, and the inbox's has already been through the hard part:
// the marker is monotonic, and it is compared at millisecond resolution because
// a raw comparison against a microsecond timestamp calls a just-read item
// unread forever. The context key here is `msgthread:<parentId>`, a namespace
// of its own so opening one thread does not mark a whole channel read.
// ---------------------------------------------------------------------------

interface ThreadInboxResult {
  items: ThreadInboxItem[];
  unreadCount: number;
  loading: boolean;
  /**
   * Advance this thread's marker. Resolves TRUE only when the marker is durable
   * — accepted by the server, or already sent for this context. The sidebar
   * ignores the result (a failed marker just comes back unread next load); the
   * inbox does not, because it TELLS the user when a read did not stick.
   */
  markThreadRead: (parentId: string) => Promise<boolean>;
  refetch: () => void;
}

export function useThreadInbox(workspaceId: string | null): ThreadInboxResult {
  const [items, setItems] = useState<ThreadInboxItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);
  const refetch = useCallback(() => setReloadToken(t => t + 1), []);

  // Marks already sent, so a re-render or a second open does not re-POST. The
  // server's guard is monotonic anyway; this just avoids the round-trip.
  const sent = useRef<Set<string>>(new Set());
  useEffect(() => { sent.current.clear(); }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) { setItems([]); return; }
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const response = await fetch(
          apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/threads`),
          { headers: apiAuthHeaders() },
        );
        const payload = await response.json().catch(() => null);
        if (cancelled) return;
        setItems(Array.isArray(payload?.data?.items) ? payload.data.items : []);
      } catch {
        // The section degrades to empty. Everything else in the sidebar keeps
        // working, and the rest of the app is already reporting a dead backend.
        if (!cancelled) setItems([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [workspaceId, reloadToken]);

  const markThreadRead = useCallback(async (parentId: string): Promise<boolean> => {
    if (!workspaceId || !parentId) return false;
    const contextKey = `msgthread:${parentId}`;
    const target = items.find(item => item.parentId === parentId);
    // Nothing to advance to: an unopened-but-already-read thread should not
    // move the marker backwards or forwards. Already-read is not a failure, so
    // it reports true — the caller asked for a state that already holds.
    if (!target) return false;
    if (!target.unread) return true;

    // Optimistic, so the row goes quiet the moment it is opened rather than on
    // the next refetch — the badge and the list move by the same one item.
    setItems(prev => prev.map(item => (item.parentId === parentId ? { ...item, unread: false } : item)));
    // The server's guard is monotonic, so a re-send would be a no-op; skipping
    // it is an optimisation, and the marker is already durable.
    if (sent.current.has(contextKey)) return true;
    sent.current.add(contextKey);

    try {
      const response = await fetch(apiUrl('/backend/inbox/read'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
        // The marker is the reply we are acknowledging, never `now()`: using the
        // clock would also mark replies that land while the thread is open, and
        // those have not been seen.
        body: JSON.stringify({ workspaceId, contextKey, readAt: target.lastReplyAt }),
      });
      if (!response.ok) throw new Error(`Inbox read HTTP ${response.status}`);
      return true;
    } catch {
      // A failed write means it comes back unread on the next load, which is
      // the safe direction — better than silently swallowing a reply. Reported
      // as false so a caller that promised the user it stuck can take it back.
      sent.current.delete(contextKey);
      return false;
    }
  }, [workspaceId, items]);

  const sorted = useMemo(() => sortThreadInbox(items), [items]);
  const unreadCount = useMemo(() => threadInboxBadgeCount(items), [items]);

  return { items: sorted, unreadCount, loading, markThreadRead, refetch };
}
