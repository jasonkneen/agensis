import { useCallback, useEffect, useRef, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';
import type { SessionAccessMember } from '../lib/sessionAccess';

// Read / grant / revoke access to one private conversation.
//
// ONLY MOUNT THIS WHEN THE SURFACE IS OPEN. All three routes are manage-gated,
// so mounting it alongside every DM in the sidebar would fire a 403 per
// conversation per render for every editor in the workspace. The dialog that
// uses it lives inside a DialogContent, which Radix unmounts while closed, so
// the fetch happens on open and not before.
//
// A 403 IS NOT AN ERROR HERE. It is the answer to "may I see who reads this",
// and it has its own state (`forbidden`) so the caller can say so in a sentence
// rather than rendering a red failure at somebody who simply is not an admin.
// 404 likewise: the frontend deploys on push while the backend needs an explicit
// Fly deploy, so these routes may genuinely not exist yet on the server this
// build is talking to. `unavailable` keeps that distinguishable from a refusal.

interface AccessResponse {
  data?: {
    sessionId?: string;
    private?: boolean;
    members?: SessionAccessMember[];
  } | null;
  error?: { message?: string } | string | null;
}

/** The server's own words when it refuses, which are better than any we'd invent. */
function errorMessage(body: AccessResponse | null, fallback: string): string {
  const error = body?.error;
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
    return error.message;
  }
  return fallback;
}

export function useSessionAccess(sessionId: string | null) {
  const [members, setMembers] = useState<SessionAccessMember[]>([]);
  const [isPrivate, setIsPrivate] = useState(false);
  const [loading, setLoading] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState('');
  /**
   * True only after the read has actually SUCCEEDED.
   *
   * A POSITIVE signal, because the caller uses it to decide whether to go and
   * fetch the workspace member list for the grant picker, and `!forbidden` is
   * false-on-the-first-render — it starts false and only becomes true once the
   * 403 lands, by which time the second request has already gone out. So an
   * editor opening the dialog fired a request for a list they may not read, and
   * a dialog opened on a conversation with no server row fired two. Both were
   * caught by tests/unit/conversationAccessDialog.test.ts.
   */
  const [loaded, setLoaded] = useState(false);
  const requestRef = useRef(0);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setMembers([]);
      setIsPrivate(false);
      setForbidden(false);
      setUnavailable(false);
      setLoaded(false);
      return;
    }
    const requestId = requestRef.current + 1;
    requestRef.current = requestId;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(
        apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/access`),
        { headers: apiAuthHeaders() },
      );
      if (requestRef.current !== requestId) return;
      if (response.status === 403) {
        setMembers([]);
        setForbidden(true);
        setUnavailable(false);
        setLoaded(false);
        return;
      }
      if (!response.ok) {
        setMembers([]);
        setForbidden(false);
        setUnavailable(true);
        setLoaded(false);
        return;
      }
      const body: AccessResponse | null = await response.json().catch(() => null);
      if (requestRef.current !== requestId) return;
      setMembers(Array.isArray(body?.data?.members) ? body.data.members : []);
      setIsPrivate(Boolean(body?.data?.private));
      setForbidden(false);
      setUnavailable(false);
      setLoaded(true);
    } catch {
      if (requestRef.current !== requestId) return;
      setMembers([]);
      setForbidden(false);
      setUnavailable(true);
      setLoaded(false);
    } finally {
      if (requestRef.current === requestId) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => { void refresh(); }, [refresh]);

  /**
   * Give one workspace member read access. `expiresInDays` of 0 (or null) sends
   * no expiry at all, which is what the route reads as open-ended.
   *
   * Always re-reads on success rather than patching state locally: the row the
   * server wrote carries `granted_by`, `created_at` and the resolved display
   * name, and inventing those here would show a list that disagrees with the
   * one the next reader gets.
   */
  const grant = useCallback(async (userId: string, expiresInDays: number | null): Promise<string> => {
    if (!sessionId || !userId) return 'Nothing to grant';
    setError('');
    try {
      const payload: Record<string, unknown> = { userId };
      if (expiresInDays && expiresInDays > 0) payload.expiresInDays = expiresInDays;
      const response = await fetch(
        apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/access`),
        {
          method: 'POST',
          headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );
      const body: AccessResponse | null = await response.json().catch(() => null);
      if (!response.ok) {
        const message = errorMessage(body, 'Could not give access');
        setError(message);
        return message;
      }
      await refresh();
      return '';
    } catch {
      const message = 'Could not reach the server';
      setError(message);
      return message;
    }
  }, [sessionId, refresh]);

  /** Take a grant back. Participants are not revocable — the route 404s on one. */
  const revoke = useCallback(async (userId: string): Promise<string> => {
    if (!sessionId || !userId) return 'Nothing to revoke';
    setError('');
    try {
      const response = await fetch(
        apiUrl(`/backend/sessions/${encodeURIComponent(sessionId)}/access/${encodeURIComponent(userId)}`),
        { method: 'DELETE', headers: apiAuthHeaders() },
      );
      if (!response.ok) {
        const body: AccessResponse | null = await response.json().catch(() => null);
        const message = errorMessage(body, 'Could not remove access');
        setError(message);
        return message;
      }
      await refresh();
      return '';
    } catch {
      const message = 'Could not reach the server';
      setError(message);
      return message;
    }
  }, [sessionId, refresh]);

  return { members, isPrivate, loading, loaded, forbidden, unavailable, error, refresh, grant, revoke };
}
