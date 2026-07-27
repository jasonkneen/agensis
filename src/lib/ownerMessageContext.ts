import { createContext, useContext } from 'react';
import type { OwnerMessage } from './tenantCampaigns';

// The context and its reader, kept out of the provider's .tsx so that file
// exports a component and nothing else — the same reason ui/button.tsx's
// variants live where they do. Nothing here renders.

export interface OwnerMessageContextValue {
  forSurface: (surface: OwnerMessage['surface']) => OwnerMessage | null;
  dismiss: (id: string) => void;
}

/**
 * Outside a provider this returns an empty list rather than throwing: an owner
 * broadcast is an extra, and a component that crashed without one would make the
 * provider load-bearing for the whole app.
 */
export const EMPTY_OWNER_MESSAGES: OwnerMessageContextValue = {
  forSurface: () => null,
  dismiss: () => {},
};

export const OwnerMessageContext = createContext<OwnerMessageContextValue>(EMPTY_OWNER_MESSAGES);

/**
 * The one owner message for a surface, and the dismissal for it.
 *
 * Dismissal is a SERVER write (see useOwnerMessages), not a stored preference:
 * it has to hold on another browser, and two accounts sharing one browser must
 * not share one dismissal.
 */
export function useOwnerMessage(surface: OwnerMessage['surface']): {
  message: OwnerMessage | null;
  dismiss: () => void;
} {
  const { forSurface, dismiss } = useContext(OwnerMessageContext);
  const message = forSurface(surface);
  return {
    message,
    dismiss: () => { if (message) dismiss(message.id); },
  };
}
