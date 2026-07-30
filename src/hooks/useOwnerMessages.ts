import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { OwnerMessage } from '../lib/tenantCampaigns';

// ---------------------------------------------------------------------------
// The RECEIVING end of an owner broadcast.
//
// One fetch per signed-in session, keyed on the user id so switching account
// re-asks instead of carrying the previous person's messages over. Not cached
// and not mirrored offline: a message the operator sent to a segment should stop
// appearing when it is dismissed, and a stale copy in IndexedDB would outlive
// that.
//
// DISMISSAL IS A SERVER WRITE, not a localStorage key. Three reasons, all of
// which the localStorage version gets wrong:
//   * it has to hold on another browser — the same person on their laptop must
//     not be told the same thing again;
//   * two accounts sharing one browser must not share one dismissal, and every
//     localStorage key in this app is scoped by WORKSPACE, not by user;
//   * the operator needs to know how many people have read it, and only the
//     server can count that.
// The row updated is the row that made the caller a recipient, so a user can
// only ever dismiss a message that was actually sent to them.
//
// The optimistic removal is deliberate: the card disappears on click and the
// request follows. A failed dismiss simply means it comes back on next load,
// which is a far better failure than a card that will not go away while the
// network is bad.
// ---------------------------------------------------------------------------

export interface OwnerMessagesResult {
  messages: OwnerMessage[];
  /** The one message for a surface, or null. Never more than one at a time. */
  forSurface: (surface: OwnerMessage['surface']) => OwnerMessage | null;
  dismiss: (id: string) => void;
}

export function useOwnerMessages(userId: string | null | undefined): OwnerMessagesResult {
  const [messages, setMessages] = useState<OwnerMessage[]>([]);

  useEffect(() => {
    if (!userId) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(apiUrl('/backend/campaign-messages'), { headers: apiAuthHeaders() });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        const list = payload?.data?.messages;
        if (cancelled || !Array.isArray(list)) return;
        setMessages(list as OwnerMessage[]);
      } catch {
        // A message nobody could fetch is a message nobody sees. There is
        // nothing useful to tell the user about it, and an error toast on every
        // offline load would be worse than silence.
      }
    })();
    return () => { cancelled = true; };
  }, [userId]);

  const dismiss = useCallback((id: string) => {
    setMessages(current => current.filter(message => message.id !== id));
    void fetch(apiUrl(`/backend/campaign-messages/${encodeURIComponent(id)}/dismiss`), {
      method: 'POST',
      headers: apiAuthHeaders(),
    }).catch(() => {
      // Already gone from this session's UI; it reappears on the next load,
      // which is the correct outcome for a dismissal that never landed.
    });
  }, []);

  // Newest first from the server, so the first match is the newest for that
  // surface. Showing one at a time is the point: three stacked owner cards in
  // the sidebar footer would be indistinguishable from a bug.
  const forSurface = useCallback(
    (surface: OwnerMessage['surface']) => messages.find(message => message.surface === surface) ?? null,
    [messages],
  );

  return { messages, forSurface, dismiss };
}
