import type { ActivityEvent } from '../types';
import { activityMetadata } from './activityEntry';

export const ACTIVITY_REDACTION_EVENT = 'agensis:activity-redaction';

export interface ActivityRedactionTarget {
  messageId?: string;
  sessionId?: string;
}

/**
 * Remove an already-rendered message activity row as soon as its source is
 * deleted. The server retains a body-free shell, but stale browser state must
 * never keep the old title/content visible while it waits for a refetch.
 */
export function redactActivityEvents(
  events: readonly ActivityEvent[],
  target: ActivityRedactionTarget,
): ActivityEvent[] {
  const messageId = String(target.messageId || '');
  const sessionId = String(target.sessionId || '');
  if (!messageId && !sessionId) return [...events];
  return events.filter((event) => {
    if (event.event_type !== 'message_sent') return true;
    if (messageId && String(event.entity_id || '') === messageId) return false;
    const metadataSessionId = String(activityMetadata(event.metadata)?.session_id || '');
    return !sessionId || metadataSessionId !== sessionId;
  });
}

export function announceActivityRedaction(target: ActivityRedactionTarget): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(ACTIVITY_REDACTION_EVENT, { detail: target }));
}
