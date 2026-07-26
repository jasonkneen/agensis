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
  markThreadRead: (parentId: string) => void;
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

  const markThreadRead = useCallback((parentId: string) => {
    if (!workspaceId || !parentId) return;
    const contextKey = `msgthread:${parentId}`;
    const target = items.find(item => item.parentId === parentId);
    // Nothing to advance to: an unopened-but-already-read thread should not
    // move the marker backwards or forwards.
    if (!target || !target.unread) return;

    // Optimistic, so the row goes quiet the moment it is opened rather than on
    // the next refetch — the badge and the list move by the same one item.
    setItems(prev => prev.map(item => (item.parentId === parentId ? { ...item, unread: false } : item)));
    if (sent.current.has(contextKey)) return;
    sent.current.add(contextKey);

    void fetch(apiUrl('/backend/inbox/read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      // The marker is the reply we are acknowledging, never `now()`: using the
      // clock would also mark replies that land while the thread is open, and
      // those have not been seen.
      body: JSON.stringify({ workspaceId, contextKey, readAt: target.lastReplyAt }),
    }).catch(() => {
      // A failed write means it comes back unread on the next load, which is
      // the safe direction — better than silently swallowing a reply.
      sent.current.delete(contextKey);
    });
  }, [workspaceId, items]);

  const sorted = useMemo(() => sortThreadInbox(items), [items]);
  const unreadCount = useMemo(() => threadInboxBadgeCount(items), [items]);

  return { items: sorted, unreadCount, loading, markThreadRead, refetch };
}
