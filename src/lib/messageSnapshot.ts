import { compareMessagePosition } from './messagePosition';
import type { Message } from '../types';

export interface MessageSnapshotOverlay {
  sessionId: string | null;
  changes: Map<string, Message | null>;
}

export function createMessageSnapshotOverlay(): MessageSnapshotOverlay {
  return { sessionId: null, changes: new Map() };
}

export function resetMessageSnapshotOverlay(
  overlay: MessageSnapshotOverlay,
  sessionId: string | null,
): void {
  const scope = sessionId ? String(sessionId) : null;
  if (overlay.sessionId === scope) return;
  overlay.sessionId = scope;
  overlay.changes.clear();
}

export function recordMessageSnapshotChange(
  overlay: MessageSnapshotOverlay,
  sessionId: string,
  message: Message | null,
  deletedId?: string,
): void {
  const scope = String(sessionId || '');
  if (!scope || overlay.sessionId !== scope) return;
  const id = String(message?.id || deletedId || '');
  if (!id) return;
  overlay.changes.set(id, message);
}

/**
 * Overlay every event/local mutation observed while a cold GET was in flight.
 * A DELETE is represented by `null`, so an older snapshot cannot resurrect a
 * row simply because absence has no timestamp of its own.
 */
export function reconcileMessageSnapshot(
  snapshot: readonly Message[],
  overlay: MessageSnapshotOverlay,
  sessionId: string,
): Message[] {
  const scope = String(sessionId || '');
  const byId = new Map<string, Message>();
  for (const row of snapshot) {
    if (String(row.session_id || '') !== scope || !row.id) continue;
    byId.set(String(row.id), row);
  }
  if (overlay.sessionId === scope) {
    for (const [id, row] of overlay.changes) {
      if (row === null) byId.delete(id);
      else if (String(row.session_id || '') === scope) byId.set(id, row);
    }
  }
  return [...byId.values()].sort(compareMessagePosition);
}

export function applyMessageRow(
  current: readonly Message[],
  row: Message,
): Message[] {
  const next = current.some(message => message.id === row.id)
    ? current.map(message => (message.id === row.id ? { ...message, ...row } : message))
    : [...current, row];
  return next.sort(compareMessagePosition);
}
