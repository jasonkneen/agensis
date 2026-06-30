import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';

export interface UserProfile {
  id: string;
  email: string;
  display_name: string;
  accent_color: string;
  created_at: string;
}

// Loads and edits the signed-in user's account profile (display name, accent
// color, password) — separate from workspace settings, which SettingsDialog
// already owns.
export function useUserProfile(userId: string | null | undefined) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!userId) { setProfile(null); return; }
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/backend/users/me'), { headers: apiAuthHeaders() });
      const body = await res.json().catch(() => null);
      if (res.ok && body?.data) setProfile(body.data);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const updateProfile = useCallback(async (updates: { display_name?: string; accent_color?: string }) => {
    const res = await fetch(apiUrl('/backend/users/me'), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify(updates),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || !body?.data) {
      return { error: body?.error?.message || 'Failed to update profile' };
    }
    setProfile(body.data);
    return { error: null };
  }, []);

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
