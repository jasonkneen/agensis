import { useCallback, useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { toast } from 'sonner';
import { onDeployPublished, type DeployPublishedPayload } from '@/lib/backendClient';
import { UpdateDialog } from '@/components/UpdateDialog';
import { fetchReleaseNotes, type ReleaseNote } from '@/lib/releaseNotes';
import { type UpdateNotification } from '@/components/notifications/NotificationsBell';
import {
  BUILD_ID,
  decideUpdateState,
  fetchRemoteVersion,
  latestReleaseId,
  readLastSeenRelease,
  writeLastSeenRelease,
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
/**
 * `swOnly` registers the service worker and does nothing else — no version check,
 * no toast, no dialog.
 *
 * The logged-OUT mount needs the SW registration (a visitor who never signs in
 * would otherwise never register one, and an outdated SW serves the stale shell
 * forever with no update path). It must NOT run the rest: "You're on the latest
 * agensis, here's what changed" was appearing on the sign-in page, to someone who
 * has not signed in and has no idea what the product is.
 */
export interface AppUpdateManagerRef {
  getUpdateNotification: () => UpdateNotification | null;
}

export function AppUpdateManager({ swOnly = false, onRef, onNotificationChange }: { swOnly?: boolean; onRef?: (ref: AppUpdateManagerRef) => void; onNotificationChange?: (notif: UpdateNotification | null) => void } = {}) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'available' | 'updated'>('available');
  const [notes, setNotes] = useState<ReleaseNote[]>([]);
  const [hasUnseenNotes, setHasUnseenNotes] = useState(false);
  const notesLoaded = useRef(false);
  const notesRef = useRef<ReleaseNote[]>([]);
  const lastCommit = useRef<string | null>(null);
  const swRegistration = useRef<ServiceWorkerRegistration | null>(null);

  const { updateServiceWorker } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      swRegistration.current = registration ?? null;
    },
  });

  // Returns the notes as well as storing them: the cold-load check has to decide
  // against the NEWEST NOTE, so it needs the value, not just the state update.
  const ensureNotes = useCallback(async (): Promise<ReleaseNote[]> => {
    if (notesLoaded.current) return notesRef.current;
    const loaded = await fetchReleaseNotes();
    notesLoaded.current = true;
    notesRef.current = loaded;
    setNotes(loaded);
    return loaded;
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

  // Expose update notification state for the notifications bell
  useEffect(() => {
    const notif = open ? {
      open: true,
      mode,
      hasUnseenNotes,
      onReload: reload,
    } : null;

    if (onRef) {
      onRef({
        getUpdateNotification: () => notif,
      });
    }

    if (onNotificationChange) {
      onNotificationChange(notif);
    }
  }, [open, mode, hasUnseenNotes, reload, onRef, onNotificationChange]);

  // A new build is live. Whether there is anything to READ about it is a
  // separate question, and conflating the two is what made this nag.
  //
  // "What's new" used to be offered on EVERY deploy. Most deploys ship no
  // release note at all — a fix, a test, a skill file — so the button opened
  // notes whose newest entry was days old. On a busy day that is a dozen
  // prompts to re-read the same stale entry. Offer the notes only when one
  // exists that this user has not seen; otherwise say the true and useful
  // thing, which is just "reload".
  const showAvailableToast = useCallback((hasUnseenNotes: boolean) => {
    toast('A new version of agensis is available', {
      // Stable id → sonner updates the existing toast instead of stacking a
      // second one when another deploy lands while this is still on screen.
      id: 'deploy-published',
      description: hasUnseenNotes
        ? 'See what’s new and reload to update.'
        : 'Reload to pick up the latest fixes.',
      duration: Infinity,
      action: hasUnseenNotes
        ? {
          label: 'What’s new',
          onClick: () => {
            setMode('available');
            setOpen(true);
          },
        }
        : { label: 'Reload', onClick: () => { void reload(); } },
    });
  }, [reload]);

  // Trigger 1: live deploy event.
  useEffect(() => {
    if (swOnly) return;
    const unsubscribe = onDeployPublished(async (payload: DeployPublishedPayload) => {
      const commit = payload?.commit ?? null;
      if (commit && commit === lastCommit.current) return;
      lastCommit.current = commit;
      // Ask the browser to fetch the freshly-published SW now, so a later Reload
      // activates the new precache rather than re-requesting stale assets.
      swRegistration.current?.update().catch(() => {});
      const loaded = await ensureNotes();
      const latest = latestReleaseId(loaded);
      const unseen = Boolean(latest) && readLastSeenRelease() !== latest;
      setHasUnseenNotes(unseen);
      showAvailableToast(unseen);
    });
    return unsubscribe;
  }, [ensureNotes, showAvailableToast, swOnly]);

  // Triggers 2 & 3: version check on cold load.
  useEffect(() => {
    if (swOnly) return;
    // In dev mode (BUILD_ID starts with 'dev'), skip the entire update check.
    // fetchRemoteVersion() already returns null for dev builds, but that doesn't
    // prevent the release-note logic from firing. Fail fast here instead.
    if (BUILD_ID.startsWith('dev')) return;
    let cancelled = false;
    (async () => {
      // Notes first: the "what's new" recap is keyed on the newest note, so the
      // decision can't be made without them. Cheap (a cached static JSON) and it
      // happens once per cold load.
      const [remote, loaded] = await Promise.all([fetchRemoteVersion(), ensureNotes()]);
      if (cancelled) return;
      const latestRelease = latestReleaseId(loaded);
      const state = decideUpdateState({
        current: BUILD_ID,
        remote: remote?.buildId ?? null,
        latestRelease,
        lastSeenRelease: readLastSeenRelease(),
      });
      if (state === 'available') {
        const unseen = Boolean(latestRelease) && readLastSeenRelease() !== latestRelease;
        setHasUnseenNotes(unseen);
        showAvailableToast(unseen);
      } else if (state === 'updated') {
        setMode('updated');
        setOpen(true);
        if (latestRelease) writeLastSeenRelease(latestRelease);
      } else if (latestRelease) {
        // 'current' — record the baseline so the NEXT authored note is detectable
        // and a brand-new visitor isn't shown a recap on their next load. This is
        // also the migration landing for users carrying only the old build key.
        writeLastSeenRelease(latestRelease);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ensureNotes, showAvailableToast, swOnly]);

  // Expose the notification state to parent via callback and ref
  useEffect(() => {
    if (open) {
      onNotificationChange?.({
        open: true,
        mode,
        hasUnseenNotes,
        onReload: reload,
      });
    } else {
      onNotificationChange?.(null);
    }
  }, [open, mode, hasUnseenNotes, reload, onNotificationChange]);

  // Nothing to render: the SW registration above is the whole job here.
  if (swOnly) return null;

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
