import { useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { onDeployPublished, type DeployPublishedPayload } from '../lib/backendClient';

// Watches for the server's `deploy_published` system event (Netlify finished
// publishing a new frontend to the CDN) and surfaces a persistent "new version —
// reload" toast. Because the realtime socket stays open across a Netlify deploy
// (only a Fly backend deploy rolls the socket), any event received during a session
// means a newer frontend than the one currently loaded — exactly the client that
// should reload.
//
// Mount once, near the app root.
export function useDeployNotification() {
  // Dedupe by commit so repeated events for the same deploy don't stack a second toast.
  const lastCommit = useRef<string | null>(null);

  useEffect(() => {
    const unsubscribe = onDeployPublished((payload: DeployPublishedPayload) => {
      const commit = payload?.commit ?? null;
      if (commit && commit === lastCommit.current) return;
      lastCommit.current = commit;

      toast('A new version of agensis is available', {
        // Stable id → sonner updates the existing toast instead of stacking on a
        // second deploy while the first is still on screen.
        id: 'deploy-published',
        description: 'Reload to get the latest update.',
        duration: Infinity,
        action: {
          label: 'Reload',
          onClick: () => window.location.reload(),
        },
      });
    });

    return unsubscribe;
  }, []);
}
