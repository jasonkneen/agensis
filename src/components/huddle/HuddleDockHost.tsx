import { lazy, Suspense } from 'react';
import { useHuddleDock } from './HuddleDockContext';

// The dock is the only importer of the LiveKit client (~1.5MB of source). Almost
// nobody is in a call at load, so the dock and LiveKit arrive as their own chunk
// the first time a huddle target exists, instead of in the entry bundle.
const HuddleDock = lazy(() => import('./HuddleDock').then(m => ({ default: m.HuddleDock })));

/** Mounts the dock only while there is a call or record to show. */
export function HuddleDockHost() {
  const dock = useHuddleDock();
  if (!dock?.target) return null;
  return (
    <Suspense fallback={null}>
      <HuddleDock />
    </Suspense>
  );
}
