import { useEffect, useRef } from 'react';
import { announceActivityRedaction } from '../lib/activityRedaction';
import {
  onRealtimeUnsubscribed,
  type RealtimeUnsubscribedPayload,
} from '../lib/backendClient';
import { redactCachedSessionMessages } from '../lib/offlineBackend';

export function revocationTargetsSession(
  payload: RealtimeUnsubscribedPayload,
  sessionId: string | null,
): boolean {
  const target = String(sessionId || '').trim();
  if (!target || payload.reason !== 'access_revoked') return false;
  const channel = String(payload.channel || '');
  return channel === target || channel.endsWith(`:${target}`);
}

/**
 * A private-session revocation is stronger than an ordinary unsubscribe:
 * content already rendered or cached is no longer authorized. Every transcript
 * consumer uses this hook to redact memory and IndexedDB immediately.
 */
export function useSessionRevocationSignal(
  sessionId: string | null,
  onRevoked: (sessionId: string) => void,
): void {
  const callbackRef = useRef(onRevoked);
  useEffect(() => {
    callbackRef.current = onRevoked;
  });

  useEffect(() => {
    if (!sessionId) return;
    return onRealtimeUnsubscribed(payload => {
      if (!revocationTargetsSession(payload, sessionId)) return;
      void redactCachedSessionMessages(sessionId).catch(() => {});
      announceActivityRedaction({ sessionId });
      callbackRef.current(sessionId);
    });
  }, [sessionId]);
}
