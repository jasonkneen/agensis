// A one-shot request for the Projects window to show something specific, set by the
// command palette. The window may not be mounted yet (it loads on demand), so the request
// is held until the window consumes it, and a listener covers a window that is already open.

export type ProjectsIntent = { page: 'dashboard' | 'projects' | 'teams' | 'members' } | { newProject: true } | { openProject: string };

const EVENT = 'agensis:projects-intent';
let pending: ProjectsIntent | null = null;

export function requestProjectsIntent(intent: ProjectsIntent): void {
  pending = intent;
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Returns the held request, once. */
export function takeProjectsIntent(): ProjectsIntent | null {
  const intent = pending;
  pending = null;
  return intent;
}

/** Calls `listener` whenever a request is made while the window is open. Returns an unsubscribe. */
export function onProjectsIntent(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
