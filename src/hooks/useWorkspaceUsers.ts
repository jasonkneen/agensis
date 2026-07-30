import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl } from '../lib/backendClient';

export type InviteRole = 'admin' | 'editor' | 'commenter' | 'viewer';
export type MemberRole = 'owner' | InviteRole;

// A workspace participant — the owner (id === null) plus every workspace_members
// row, each joined to app_users so we always have an email to show.
export interface WorkspaceUser {
  id: string | null;
  user_id: string;
  email: string;
  role: MemberRole;
  invited_by: string | null;
  created_at: string;
}

export interface WorkspaceInvite {
  id: string;
  workspace_id: string;
  token: string;
  email: string;
  role: InviteRole;
  status: 'pending' | 'accepted' | 'revoked';
  created_by_email: string | null;
  accepted_by_email: string | null;
  accepted_at: string | null;
  expires_at: string | null;
  // Soft delete for the list only — the row (and its acceptance record) always
  // survives. null = shown. See src/lib/inviteDismissal.ts for who may be set.
  dismissed_at: string | null;
  created_at: string;
}

export function useWorkspaceUsers(workspaceId: string | null) {
  const [members, setMembers] = useState<WorkspaceUser[]>([]);
  const [invites, setInvites] = useState<WorkspaceInvite[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!workspaceId) { setMembers([]); setInvites([]); return; }
    setLoading(true);
    try {
      const [mRes, iRes] = await Promise.all([
        fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/members`), { headers: apiAuthHeaders() }),
        fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/invites`), { headers: apiAuthHeaders() }),
      ]);
      const m = await mRes.json().catch(() => null);
      const i = await iRes.json().catch(() => null);
      if (Array.isArray(m?.data)) setMembers(m.data as WorkspaceUser[]);
      if (Array.isArray(i?.data)) setInvites(i.data as WorkspaceInvite[]);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  const createInvite = useCallback(async (role: InviteRole, email?: string): Promise<WorkspaceInvite | null> => {
    if (!workspaceId) return null;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/invites`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ role, email: email || '' }),
    });
    const payload = await res.json().catch(() => null);
    const invite = (payload?.data ?? null) as WorkspaceInvite | null;
    if (invite) setInvites(prev => [invite, ...prev]);
    return invite;
  }, [workspaceId]);

  const revokeInvite = useCallback(async (inviteId: string) => {
    if (!workspaceId) return;
    await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`), {
      method: 'DELETE',
      headers: apiAuthHeaders(),
    });
    setInvites(prev => prev.map(i => i.id === inviteId ? { ...i, status: 'revoked' } : i));
  }, [workspaceId]);

  // Tidy a spent link out of the list, or put it back. The server refuses to
  // dismiss a still-active link (409), so a rejected call must not leave the
  // local row looking hidden — hence the refresh on failure rather than an
  // unconditional optimistic write.
  const setInviteDismissed = useCallback(async (inviteId: string, dismissed: boolean) => {
    if (!workspaceId) return;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/invites/${encodeURIComponent(inviteId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ dismissed }),
    });
    if (!res.ok) {
      await refresh();
      throw new Error(dismissed ? 'Failed to dismiss invite link' : 'Failed to restore invite link');
    }
    const payload = await res.json().catch(() => null);
    const row = (payload?.data ?? null) as WorkspaceInvite | null;
    setInvites(prev => prev.map(i => i.id === inviteId
      ? { ...i, dismissed_at: row?.dismissed_at ?? (dismissed ? new Date().toISOString() : null) }
      : i));
  }, [workspaceId, refresh]);

  // Bulk clear. The server applies the same spent-only predicate, so anything
  // still live is skipped rather than hidden; re-read the list afterwards so
  // what the user sees is what actually happened.
  const dismissSpentInvites = useCallback(async () => {
    if (!workspaceId) return;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/invites/dismiss-spent`), {
      method: 'POST',
      headers: apiAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to clear spent invite links');
    await refresh();
  }, [workspaceId, refresh]);

  const removeMember = useCallback(async (memberId: string) => {
    if (!workspaceId) return;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`), {
      method: 'DELETE',
      headers: apiAuthHeaders(),
    });
    if (!res.ok) throw new Error('Failed to remove workspace member');
    setMembers(prev => prev.filter(m => m.id !== memberId));
  }, [workspaceId]);

  const changeMemberRole = useCallback(async (memberId: string, role: InviteRole) => {
    if (!workspaceId) return;
    const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/members/${encodeURIComponent(memberId)}`), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) throw new Error('Failed to update workspace member role');
    setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role } : m));
  }, [workspaceId]);

  return {
    members,
    invites,
    loading,
    refresh,
    createInvite,
    revokeInvite,
    setInviteDismissed,
    dismissSpentInvites,
    removeMember,
    changeMemberRole,
  };
}

// Build the shareable invite URL the recipient opens. The accept flow reads the
// ?invite= param on the app entry point (see App.tsx).
export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/app?invite=${encodeURIComponent(token)}`;
}
