import { createContext, useEffect, useRef, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { useHuddle } from '@/hooks/useHuddle';
import { sameHuddleAgents, type HuddleAgentOption } from '@/lib/huddleAgents';

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

/**
 * What the dock is showing, or null.
 *
 * TWO MODES, one slot. A `sessionId` means a CALL in that conversation: the
 * hook below joins it and the dock mounts LiveKit. A `huddleId` with no
 * sessionId means a RECORD — someone clicked "You were in a huddle" on a call
 * that ended, possibly months ago. The huddle hook is inert for a record (its
 * base path needs a session), so nothing joins, nothing subscribes and no
 * token is ever minted; the panel fetches the one huddle by id and renders its
 * transcript.
 *
 * One slot rather than two because the dock is one panel. Opening a record
 * while a call is running replaces it — and `openHuddleRecord` posts the leave
 * on the way out rather than letting the connection be dropped silently.
 */
export interface HuddleTarget {
  workspaceId: string;
  /** The conversation whose call this is. '' for a record. */
  sessionId: string;
  /** For the panel header, so it can say WHERE the call is without a lookup. */
  title: string;
  /** One specific, usually ended, huddle to READ. Set only in record mode. */
  huddleId?: string;
  /**
   * The conversation's agents, in roster order. Carried on the target because
   * the dock is mounted above every view and cannot see a channel's
   * participants — but it needs them for two things a call is useless without:
   * the @mention that makes a spoken sentence wake anybody in a channel, and
   * the participant chips (an agent never holds a LiveKit connection, so a
   * three-agent call built from presence alone looks empty).
   *
   * Empty in a DM, where the single agent already answers a plain message.
   */
  agents?: HuddleAgentOption[];
}

export type HuddleDockSession = ReturnType<typeof useHuddle>;

interface HuddleDockValue {
  target: HuddleTarget | null;
  session: HuddleDockSession | null;
  /** Enter (or switch to) a conversation's huddle. */
  openHuddle: (target: HuddleTarget) => void;
  /**
   * READ one huddle, live or long finished — what a channel marker links to.
   *
   * The huddle used to open in a side panel inside the channel. That panel is
   * gone: the dock is the only place a huddle is shown, so there is one answer
   * to "where is the huddle" instead of two surfaces that could disagree.
   */
  openHuddleRecord: (record: { workspaceId: string; huddleId: string; title: string }) => void;
  /**
   * Keep the target's agent roster current while the channel is on screen.
   *
   * A snapshot taken at open time is wrong twice over: the participant list is
   * still loading when the button is clicked (so the call starts agent-less and
   * every spoken sentence wakes nobody), and an agent added mid-call would
   * never appear. Ignored for any session that is not the current target.
   */
  setTargetAgents: (sessionId: string, agents: HuddleAgentOption[]) => void;
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
    // A record has no sessionId, so reading an ended huddle can never start a
    // new one in the channel it happened in — which is exactly what a naive
    // "open this huddle" would have done.
    if (!sessionId || !startOrJoin) return;
    if (joinedRef.current === sessionId) return;
    joinedRef.current = sessionId;
    void startOrJoin();
  }, [target?.sessionId, startOrJoin]);

  // Held in a ref so openHuddleRecord can hang up without depending on the
  // session object, which useHuddle rebuilds on every render.
  const leaveRef = useRef(session?.leave);
  leaveRef.current = session?.leave;

  const openHuddleRecord = useCallback((record: { workspaceId: string; huddleId: string; title: string }) => {
    // Reading an old huddle takes the dock's one slot. Post the leave first so
    // presence is cleaned up now rather than by the server's staleness reaper —
    // re-keying the hook alone drops the connection silently and leaves the
    // roster claiming someone is still in a call they walked out of.
    leaveRef.current?.();
    joinedRef.current = '';
    setTarget({
      workspaceId: record.workspaceId,
      sessionId: '',
      title: record.title,
      huddleId: record.huddleId,
    });
    setCollapsed(false);
  }, []);

  const setTargetAgents = useCallback((sessionId: string, agents: HuddleAgentOption[]) => {
    setTarget(current => {
      if (!current || current.sessionId !== sessionId) return current;
      // Identity-stable when nothing changed: the roster is recomputed on every
      // render of the channel, and returning a new target object each time would
      // re-render the whole dock (and its speech hooks) for no reason.
      if (sameHuddleAgents(current.agents ?? [], agents)) return current;
      return { ...current, agents };
    });
  }, []);

  const closeHuddle = useCallback(() => {
    setTarget(null);
    setCollapsed(false);
    // Clear the guard, so reopening the SAME conversation later joins again
    // rather than sitting inert because it was joined once before.
    joinedRef.current = '';
  }, []);

  const value = useMemo<HuddleDockValue>(
    () => ({ target, session, openHuddle, openHuddleRecord, closeHuddle, setTargetAgents, collapsed, setCollapsed }),
    [target, session, openHuddle, openHuddleRecord, closeHuddle, setTargetAgents, collapsed],
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
