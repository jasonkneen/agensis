import { createContext, useContext, type ReactNode } from 'react';
import { useHuddle } from '@/hooks/useHuddle';

/** Derived rather than declared, so the hook stays the single source of truth. */
export type HuddleSession = ReturnType<typeof useHuddle>;

// One huddle hook, two render sites.
//
// The huddle used to own a whole strip below the channel header, which spent
// almost all of its life showing the word "Huddle" and a "Start huddle" button
// — a full row of chrome for one control. The trigger now lives in the channel
// toolbar and the strip appears only when there is something to say.
//
// Those two live in different parts of the header tree, so they cannot share
// state by props without lifting `useHuddle` into ChatWindowContent and
// threading a dozen values through it. This context is the seam instead.
//
// It is deliberately scoped to the header subtree, NOT the whole channel: the
// hook is realtime-subscription driven (no polling), so a re-render here means
// the huddle genuinely changed, but there is still no reason to re-render the
// transcript when someone joins a call.

// Exported because the app-level dock provides it directly from the session it
// already owns: the dock is mounted OUTSIDE this channel-scoped provider, so
// without it the panel inside the dock had no session and fell back to a
// one-shot fetch that never saw the huddle change again.
export const HuddleSessionContext = createContext<HuddleSession | null>(null);

interface HuddleSessionProviderProps {
  workspaceId: string | null;
  sessionId: string | null;
  children: ReactNode;
}

export function HuddleSessionProvider({ workspaceId, sessionId, children }: HuddleSessionProviderProps) {
  const huddle = useHuddle(workspaceId, sessionId);
  return <HuddleSessionContext.Provider value={huddle}>{children}</HuddleSessionContext.Provider>;
}

/**
 * Null outside a provider — both consumers render nothing in that case rather
 * than throwing, so a channel surface that never opted in (a read-only or
 * embedded view) simply has no huddle UI.
 */
export function useHuddleSession(): HuddleSession | null {
  return useContext(HuddleSessionContext);
}
