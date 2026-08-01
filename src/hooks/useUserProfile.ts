import { useCallback, useEffect, useRef, useState } from 'react';
import {
  apiAuthHeaders,
  apiUrl,
  onReadReceiptPreference,
  onRealtimeUnsubscribed,
} from '../lib/backendClient';
import { publishUserProfileSync, subscribeUserProfileSync, type UserProfileSyncValue } from '../lib/userProfileSync';

export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  accent_color: string;
  /**
   * The read-receipts opt-out, and it is RECIPROCAL: false means your markers
   * are never written AND you stop seeing anyone else's. Both halves are
   * enforced server-side in SQL (shared/read-receipts.cjs) — this value is what
   * the settings toggle renders and what stops the client asking, never the
   * thing that protects anybody.
   *
   * Optional because a client can reach a backend whose column predates it.
   */
  share_read_receipts?: boolean;
  created_at: string;
}

// Loads and edits the signed-in user's account profile (display name, accent
// color, password) — separate from workspace settings, which SettingsDialog
// already owns.
export function useUserProfile(userId: string | null | undefined) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const revision = useRef(0);
  const pendingPatch = useRef<UserProfileSyncValue>({});
  const identityGeneration = useRef(0);

  useEffect(() => {
    // Hook instances survive account switches in the desktop shell. No revision
    // or optimistic overlay from account A may be applied to account B, and an
    // in-flight A response must not win after the identity changed.
    identityGeneration.current += 1;
    revision.current = 0;
    pendingPatch.current = {};
    setProfile(null);
    setLoading(false);
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    return subscribeUserProfileSync((event) => {
      if (event.userId !== userId) return;
      revision.current += 1;
      if (event.profile) {
        // Keep the full event as the overlay for an older GET already in
        // flight. Clearing this here would let that response restore the
        // pre-save receipt preference one microtask after the dialog saved it.
        pendingPatch.current = event.profile;
        setProfile(event.profile as UserProfile);
        return;
      }
      if (!event.patch) return;
      pendingPatch.current = { ...pendingPatch.current, ...event.patch };
      setProfile(current => current ? { ...current, ...event.patch } : current);
    });
  }, [userId]);

  useEffect(() => {
    if (!userId) return;
    const stopPreference = onReadReceiptPreference((event) => {
      if (event.userId !== userId) return;
      publishUserProfileSync({
        userId,
        patch: { share_read_receipts: event.enabled },
      });
    });
    const stopLegacyDisable = onRealtimeUnsubscribed(({ channel, reason }) => {
      // Generic access_revoked also means "removed from one private session"
      // and must never change an account-wide preference. Profile opt-out uses
      // its own reason so tabs/devices can safely update their cached profile.
      if (reason !== 'read_receipts_disabled' || !channel.startsWith('session_read_state:')) return;
      publishUserProfileSync({ userId, patch: { share_read_receipts: false } });
    });
    return () => {
      stopPreference();
      stopLegacyDisable();
    };
  }, [userId]);

  const refresh = useCallback(async () => {
    if (!userId) { setProfile(null); return; }
    const requestGeneration = identityGeneration.current;
    const startedAtRevision = revision.current;
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/backend/users/me'), { headers: apiAuthHeaders() });
      const body = await res.json().catch(() => null);
      if (identityGeneration.current !== requestGeneration) return;
      if (res.ok && body?.data) {
        // A profile signal may arrive while this request is in flight. Do not
        // let an older GET restore receipts after a live opt-out revocation.
        const next = revision.current === startedAtRevision
          ? body.data
          : { ...body.data, ...pendingPatch.current };
        setProfile(next);
      }
    } finally {
      if (identityGeneration.current === requestGeneration) setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateProfile = useCallback(async (updates: { display_name?: string; accent_color?: string; share_read_receipts?: boolean }) => {
    const res = await fetch(apiUrl('/backend/users/me'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(updates),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data) {
      return { error: body?.error?.message || 'Failed to update profile' };
    }
    publishUserProfileSync({ userId: String(body.data.id || userId || ''), profile: body.data });
    return { error: null };
  }, [userId]);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await fetch(apiUrl('/backend/users/me/change-password'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ currentPassword, newPassword }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      return { error: body?.error?.message || 'Failed to change password' };
    }
    return { error: null };
  }, []);

  return { profile, loading, refresh, updateProfile, changePassword };
}
