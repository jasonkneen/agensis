import { createContext, useEffect, useRef, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useHuddle } from '@/hooks/useHuddle';

// ---------------------------------------------------------------------------
// THE HUDDLE LIVES AT APP LEVEL, NOT INSIDE A CHANNEL.
//
// It used to be mounted inside ChatWindowContent, which meant the LiveKit
// connection was a child of the channel view: navigating away unmounted it and
// dropped the call. You could not look at a document, or another channel, or
// the agents list, without leaving the huddle you were in.
//
// So the session hook is lifted here, above every window and every view, and
// keyed on a target this provider owns rather than on "whichever channel is on
// screen". Navigation cannot touch it, because navigation happens underneath.
//
// ONE AT A TIME falls out of the shape rather than being enforced by a check:
// there is a single `target`, so joining a second huddle replaces the first
// (and `leave()` runs on the way out — see `openHuddle`). A guard would have
// needed a rule for what happens on the second join; a single slot does not.
// ---------------------------------------------------------------------------

/** Which conversation's huddle this app is currently in, or null. */
export interface HuddleTarget {
  workspaceId: string;
  sessionId: string;
  /** For the panel header, so it can say WHERE the call is without a lookup. */
  title: string;
}

export type HuddleDockSession = ReturnType<typeof useHuddle>;

interface HuddleDockValue {
  target: HuddleTarget | null;
  session: HuddleDockSession | null;
  /** Enter (or switch to) a conversation's huddle. */
  openHuddle: (target: HuddleTarget) => void;
  /** Drop the panel entirely — used after leaving or ending. */
  closeHuddle: () => void;
  /** Panel visibility, independent of connection: you can collapse a live call. */
  collapsed: boolean;
  setCollapsed: (value: boolean) => void;
}

const HuddleDockContext = createContext<HuddleDockValue | null>(null);

export function HuddleDockProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HuddleTarget | null>(null);
  const [collapsed, setCollapsed] = useState(false);

  // Keyed on the TARGET, not on the visible channel. This is the whole point:
  // the hook's identity is stable across navigation, so the socket it owns is
  // never torn down by a route change.
  const session = useHuddle(target?.workspaceId ?? null, target?.sessionId ?? null);

  const openHuddle = useCallback((next: HuddleTarget) => {
    setTarget(current => {
      // Switching conversations mid-call: nothing here can leave the old call,
      // because the hook for it is about to be re-keyed and its cleanup will
      // run. Recorded rather than silently relied upon.
      if (current && current.sessionId === next.sessionId) return current;
      return next;
    });
    setCollapsed(false);
  }, []);

  // JOIN the call once per target. openHuddle only records WHICH conversation
  // the dock is for; without this the panel opened and nothing ever connected,
  // because the old toolbar button called startOrJoin() itself and the lifted
  // path dropped that step. Keyed on sessionId so re-renders do not re-join,
  // and so switching conversations joins the new one exactly once.
  const joinedRef = useRef<string>('');
  const startOrJoin = session?.startOrJoin;
  useEffect(() => {
    const sessionId = target?.sessionId || '';
    if (!sessionId || !startOrJoin) return;
    if (joinedRef.current === sessionId) return;
    joinedRef.current = sessionId;
    void startOrJoin();
  }, [target?.sessionId, startOrJoin]);

  const closeHuddle = useCallback(() => {
    setTarget(null);
    setCollapsed(false);
    // Clear the guard, so reopening the SAME conversation later joins again
    // rather than sitting inert because it was joined once before.
    joinedRef.current = '';
  }, []);

  const value = useMemo<HuddleDockValue>(
    () => ({ target, session, openHuddle, closeHuddle, collapsed, setCollapsed }),
    [target, session, openHuddle, closeHuddle, collapsed],
  );

  return <HuddleDockContext.Provider value={value}>{children}</HuddleDockContext.Provider>;
}

/**
 * Null outside the provider rather than throwing: a read-only or embedded chat
 * surface that never opted in simply has no huddle affordances, which is the
 * same contract the older channel-scoped context had.
 */
export function useHuddleDock(): HuddleDockValue | null {
  return useContext(HuddleDockContext);
}
