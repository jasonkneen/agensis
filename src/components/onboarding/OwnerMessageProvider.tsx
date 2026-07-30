import { useMemo, type ReactNode } from 'react';
import { useOwnerMessages } from '@/hooks/useOwnerMessages';
import { OwnerMessageContext } from '@/lib/ownerMessageContext';

// ---------------------------------------------------------------------------
// One fetch, three surfaces.
//
// An owner broadcast can land in the sidebar footer, in a dialog over the app,
// or under the home composer — three places in three different subtrees of a
// very large App.tsx. A context rather than three prop paths, so there is ONE
// list, ONE dismissal, and no possibility of the dialog and the sidebar
// disagreeing about whether a message is still live.
//
// The context itself and its reader hook live in src/lib/ownerMessageContext.ts,
// so this file exports a component and nothing else.
// ---------------------------------------------------------------------------

export function OwnerMessageProvider({
  userId,
  children,
}: {
  userId: string | null | undefined;
  children: ReactNode;
}) {
  const { forSurface, dismiss } = useOwnerMessages(userId);
  const value = useMemo(() => ({ forSurface, dismiss }), [forSurface, dismiss]);
  return <OwnerMessageContext.Provider value={value}>{children}</OwnerMessageContext.Provider>;
}
