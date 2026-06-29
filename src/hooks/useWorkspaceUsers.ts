import { useCallback, useEffect, useState } from 'react';
import { apiAuthHeaders, apiUrl, backendClient } from '../lib/backendClient';

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

  const removeMember = useCallback(async (memberId: string) => {
    await backendClient.from('workspace_members').delete().eq('id', memberId);
    setMembers(prev => prev.filter(m => m.id !== memberId));
  }, []);

  const changeMemberRole = useCallback(async (memberId: string, role: 'editor' | 'viewer') => {
    await backendClient.from('workspace_members').update({ role }).eq('id', memberId);
    setMembers(prev => prev.map(m => m.id === memberId ? { ...m, role } : m));
  }, []);

  return { members, invites, loading, refresh, createInvite, revokeInvite, removeMember, changeMemberRole };
}

// Build the shareable invite URL the recipient opens. The accept flow reads the
// ?invite= param on load (see App.tsx).
export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, '')}/?invite=${encodeURIComponent(token)}`;
}
