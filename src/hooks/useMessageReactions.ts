import { useCallback, useMemo, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import { noteReactionUse, type ReactionUse } from '../lib/reactionBar';
import type { Message as ChatMessage } from '../types';

// Reacting from a surface that does not own the big message-override machinery
// in ChatWindowContent — today the sub-thread panel.
//
// THE SERVER OWNS THE MUTATION. POST /backend/messages/:id/reactions is one
// atomic statement with the reactor bound from the session, so the map built
// below is only a PREDICTION for the moment before realtime lands. That matters:
// the reaction map used to be computed client-side and written back whole, which
// meant two people reacting inside the propagation window each built from a
// stale base and the second write silently erased the first.
//
// WHY THE OVERRIDE IS DROPPED ON BOTH PATHS. Success and failure both clear it.
// Pinning the predicted map in place would mask every later realtime UPDATE for
// that row, including somebody else reacting to it — the row would freeze at
// your guess. Clearing on failure is what reverts a rejected click.

type ReactionMap = Record<string, string[]>;

export interface UseMessageReactionsResult {
  /** The message's reactions, with any in-flight prediction applied. */
  reactionsFor: (message: ChatMessage) => ReactionMap;
  toggle: (message: ChatMessage, reaction: string, op: 'add' | 'remove') => void;
  /** Local-only picker history for the "Frequently used" row. */
  reactionUses: ReactionUse[];
}

export function useMessageReactions(currentUserId: string | null | undefined): UseMessageReactionsResult {
  const [overrides, setOverrides] = useState<Record<string, ReactionMap>>({});
  const [reactionUses, setReactionUses] = useState<ReactionUse[]>([]);
  // Monotonic per message, so a slow first click cannot clear the override a
  // faster second click just wrote.
  const versionsRef = useRef(new Map<string, number>());

  const reactionsFor = useCallback(
    (message: ChatMessage): ReactionMap => overrides[message.id] ?? (message.reactions as ReactionMap) ?? {},
    [overrides],
  );

  const toggle = useCallback((message: ChatMessage, reaction: string, op: 'add' | 'remove') => {
    const uid = currentUserId || null;
    const version = (versionsRef.current.get(message.id) ?? 0) + 1;
    versionsRef.current.set(message.id, version);

    if (uid) {
      const prev: ReactionMap = (message.reactions as ReactionMap) ?? {};
      const users = prev[reaction] ?? [];
      const next: ReactionMap = {
        ...prev,
        [reaction]: op === 'add' ? [...new Set([...users, uid])] : users.filter(u => u !== uid),
      };
      if (next[reaction].length === 0) delete next[reaction];
      setOverrides(current => ({ ...current, [message.id]: next }));
    }
    if (op === 'add') setReactionUses(prev => noteReactionUse(prev, reaction, Date.now()));

    const clear = () => {
      if (versionsRef.current.get(message.id) !== version) return;
      setOverrides(current => {
        if (!(message.id in current)) return current;
        const next = { ...current };
        delete next[message.id];
        return next;
      });
    };

    void (async () => {
      try {
        const res = await fetch(apiUrl(`/backend/messages/${encodeURIComponent(message.id)}/reactions`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
          body: JSON.stringify({ reaction, op }),
        });
        if (!res.ok) throw new Error('reaction failed');
      } catch {
        // Fall through: clear() below reverts the prediction either way.
      } finally {
        clear();
      }
    })();
  }, [currentUserId]);

  return useMemo(
    () => ({ reactionsFor, toggle, reactionUses }),
    [reactionsFor, toggle, reactionUses],
  );
}
