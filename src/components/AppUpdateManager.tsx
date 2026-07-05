import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { toast } from 'sonner';
import { onDeployPublished, type DeployPublishedPayload } from '@/lib/backendClient';
import { UpdateDialog } from '@/components/UpdateDialog';
import { fetchReleaseNotes, type ReleaseNote } from '@/lib/releaseNotes';
import {
  BUILD_ID,
  decideUpdateState,
  fetchRemoteVersion,
  readLastSeenBuild,
  writeLastSeenBuild,
} from '@/lib/appVersion';

// Owns the whole "what's new" update surface. Mount once, near the app root.
//
// Three triggers converge on one themed dialog:
//   1. deploy_published WS event — a new frontend published while this tab is
//      open (live sessions). Shows the "reload" toast → dialog.
//   2. cold-load version check — /version.json's buildId differs from the baked
//      BUILD_ID (e.g. an installed PWA reopened onto a stale cache). Same toast.
//   3. first load AFTER an update — we're running a build the user hasn't seen
//      notes for; shows the "what's new" recap dialog once, then records it.
//
// The reload path uses vite-plugin-pwa's `updateServiceWorker(true)` to activate
// the waiting service worker (skipWaiting) and swap in the new precache — a real
// cache bust — falling back to a hard reload where no SW is involved.
export function AppUpdateManager() {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'available' | 'updated'>('available');
  const [notes, setNotes] = useState<ReleaseNote[]>([]);
  const notesLoaded = useRef(false);
  const lastCommit = useRef<string | null>(null);
  const swRegistration = useRef<ServiceWorkerRegistration | null>(null);

  const { updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      swRegistration.current = registration ?? null;
    },
  });

  const ensureNotes = useCallback(async () => {
    if (notesLoaded.current) return;
    const loaded = await fetchReleaseNotes();
    notesLoaded.current = true;
    setNotes(loaded);
  }, []);

  const reload = useCallback(async () => {
    try {
      // Activates the waiting SW and reloads via controllerchange (cache bust).
      // Resolves without reloading if no SW is waiting — then we hard-reload.
      await updateServiceWorker(true);
    } catch {
      /* no SW / dev / Electron — fall through */
    }
    const url = new URL(window.location.href);
    url.searchParams.set('agensisUpdate', BUILD_ID || String(Date.now()));
    window.location.replace(url.href);
  }, [updateServiceWorker]);

  const showAvailableToast = useCallback(() => {
    toast('A new version of agensis is available', {
      // Stable id → sonner updates the existing toast instead of stacking a
      // second one when another deploy lands while this is still on screen.
      id: 'deploy-published',
      description: 'See what’s new and reload to update.',
      duration: Infinity,
      action: {
        label: 'What’s new',
        onClick: () => {
          setMode('available');
          setOpen(true);
        },
      },
    });
  }, []);

  // Trigger 1: live deploy event.
  useEffect(() => {
    const unsubscribe = onDeployPublished(async (payload: DeployPublishedPayload) => {
      const commit = payload?.commit ?? null;
      if (commit && commit === lastCommit.current) return;
      lastCommit.current = commit;
      // Ask the browser to fetch the freshly-published SW now, so a later Reload
      // activates the new precache rather than re-requesting stale assets.
      swRegistration.current?.update().catch(() => {});
      await ensureNotes();
      showAvailableToast();
    });
    return unsubscribe;
  }, [ensureNotes, showAvailableToast]);

  // Triggers 2 & 3: version check on cold load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const remote = await fetchRemoteVersion();
      if (cancelled) return;
      const state = decideUpdateState({
        current: BUILD_ID,
        remote: remote?.buildId ?? null,
        lastSeen: readLastSeenBuild(),
      });
      if (state === 'available') {
        await ensureNotes();
        if (cancelled) return;
        showAvailableToast();
      } else if (state === 'updated') {
        await ensureNotes();
        if (cancelled) return;
        setMode('updated');
        setOpen(true);
        writeLastSeenBuild(BUILD_ID);
      } else {
        // 'current' — record the baseline so future updates are detectable and a
        // brand-new visitor isn't shown an "updated" recap on their next load.
        writeLastSeenBuild(BUILD_ID);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureNotes, showAvailableToast]);

  return (
    <UpdateDialog
      open={open}
      onOpenChange={setOpen}
      notes={notes}
      mode={mode}
      onReload={reload}
    />
  );
}
