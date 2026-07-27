// A one-slot store for the message the sign-in screen must show.
//
// Why not a toast: the two events that write here — "your session expired" and
// "social login failed" — both dump the user back on the login screen. A toast
// fades while the user is still staring at a page that no longer works. The
// login screen itself is the blocking surface, so the message has to survive
// long enough to render there.
//
// Deliberately a plain module-level store rather than React context: it is
// written from `backendClient.ts` (non-React) on a 401, and read by `useAuth`.

let currentNotice: string | null = null;
const listeners = new Set<(notice: string | null) => void>();

export function getAuthNotice(): string | null {
  return currentNotice;
}

export function setAuthNotice(notice: string | null): void {
  // Idempotent: re-setting the same message is a no-op, so a burst of failures
  // cannot cause a render storm.
  if (currentNotice === notice) return;
  currentNotice = notice;
  for (const listener of listeners) {
    try {
      listener(currentNotice);
    } catch {
      // one listener throwing must not stop delivery to the others
    }
  }
}

export function clearAuthNotice(): void {
  setAuthNotice(null);
}

export function subscribeAuthNotice(listener: (notice: string | null) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
