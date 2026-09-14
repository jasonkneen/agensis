import type { Task } from '../types';

type AppletMessageHandler = (event: MessageEvent) => void;

// Every iframe message is delivered to every `window.message` listener. A
// listener per applet therefore turns M bridge messages across N applets into
// M*N handler invocations, including N-1 handlers that only reject the source.
// Keep one listener at the host boundary and route by WindowProxy identity.
const appletMessageTargets = new Map<MessageEventSource, AppletMessageHandler>();
let appletMessageListenerInstalled = false;

function routeAppletMessage(event: MessageEvent) {
 const message = event.data;
 if (!message || typeof message !== 'object' || message.source !== 'agensis-applet') return;
 if (!event.source) return;
 appletMessageTargets.get(event.source)?.(event);
}

/** Register one sandboxed applet with the shared host message bridge. */
export function registerAppletMessageTarget(
 source: MessageEventSource,
 handler: AppletMessageHandler,
): () => void {
 appletMessageTargets.set(source, handler);
 if (!appletMessageListenerInstalled) {
  window.addEventListener('message', routeAppletMessage);
  appletMessageListenerInstalled = true;
 }

 return () => {
  if (appletMessageTargets.get(source) === handler) appletMessageTargets.delete(source);
  if (appletMessageTargets.size === 0 && appletMessageListenerInstalled) {
   window.removeEventListener('message', routeAppletMessage);
   appletMessageListenerInstalled = false;
  }
 };
}

// Allowlist: only user-editable Task fields may be set by a sandboxed applet via
// the `agensis:updateTask` bridge message. Excludes ids, workspace_id,
// created_by, assignee_id, source_*, timestamps, version, and completed_at to
// prevent mass-assignment of privileged columns from untrusted iframe content.
export const APPLET_TASK_UPDATE_FIELDS = [
 'title',
 'description',
 'status',
 'priority',
 'due_date',
] as const;

/**
 * Filter an applet-supplied `updates` object down to the allowlisted, user-
 * editable Task fields. This is the single source of truth for the applet
 * mass-assignment guard — both CanvasObjectRenderer's bridge handler and the
 * unit test import THIS function, so the test exercises the real code path
 * rather than a drifting copy.
 */
export function filterAppletTaskUpdates(updates: Record<string, unknown>): Partial<Task> {
 const safeUpdates: Partial<Task> = {};
 for (const key of APPLET_TASK_UPDATE_FIELDS) {
  if (Object.prototype.hasOwnProperty.call(updates, key)) {
   (safeUpdates as Record<string, unknown>)[key] = updates[key];
  }
 }
 return safeUpdates;
}
