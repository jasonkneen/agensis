import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';
import { useWorkspaceListState, useWorkspaceState } from './useWorkspaceState';

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceMemberRole;
  invited_by: string | null;
  created_at: string;
  email?: string;
}

export type WorkspaceMemberRole = 'owner' | 'admin' | 'editor' | 'commenter' | 'viewer';

export function useSharing(workspaceId: string | null, currentUserId: string | undefined) {
  const [members, setMembers, beginMembersRequest] = useWorkspaceListState<WorkspaceMember>(workspaceId, []);
  const [autoShare, setAutoShareState, beginAutoShareRequest] = useWorkspaceState(workspaceId, false, false);
  const [loading, setLoading] = useState(false);

  const fetchMembers = useCallback(async () => {
    const isCurrent = beginMembersRequest();
    if (!workspaceId) {
      setMembers([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await backendClient
        .from<WorkspaceMember[]>('workspace_members')
        .select('*')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: true });

      if (isCurrent() && data) setMembers(data);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginMembersRequest, setMembers, workspaceId]);

  const fetchAutoShare = useCallback(async () => {
    const isCurrent = beginAutoShareRequest();
    if (!workspaceId) {
      setAutoShareState(false);
      return;
    }
    const { data } = await backendClient
      .from<{ auto_share?: boolean }>('workspaces')
      .select('auto_share')
      .eq('id', workspaceId)
      .maybeSingle();
    if (isCurrent() && data) setAutoShareState(data.auto_share ?? false);
  }, [beginAutoShareRequest, setAutoShareState, workspaceId]);

  useEffect(() => {
    fetchMembers();
    fetchAutoShare();
  }, [fetchMembers, fetchAutoShare]);

  const toggleAutoShare = useCallback(async () => {
    if (!workspaceId) return;
    const isCurrent = beginAutoShareRequest();
    const newValue = !autoShare;
    setAutoShareState(newValue);
    const { error } = await backendClient
      .from('workspaces')
      .update({ auto_share: newValue })
      .eq('id', workspaceId);

    if (error) {
      if (isCurrent()) setAutoShareState(!newValue);
      return;
    }

    if (isCurrent()) await fetchAutoShare();
  }, [autoShare, beginAutoShareRequest, fetchAutoShare, setAutoShareState, workspaceId]);

  const inviteByEmail = useCallback(async (email: string): Promise<{ error: string | null }> => {
    if (!workspaceId || !currentUserId) return { error: 'Not ready' };

    // F9: the RPC now requires 'manage' on the target workspace (enumeration guard).
    const { data: users, error: lookupErr } = await backendClient
      .rpc<Array<{ id: string }>>('lookup_user_by_email', { lookup_email: email, workspace_id: workspaceId });

    if (lookupErr || !users || users.length === 0) {
      return { error: 'No user found with that email address. They need to sign up first.' };
    }

    const targetUserId = users[0].id;

    if (targetUserId === currentUserId) {
      return { error: 'You are already the owner of this workspace.' };
    }

    const existing = members.find(m => m.user_id === targetUserId);
    if (existing) {
      return { error: 'This user already has access.' };
    }

    const { error: insertErr } = await backendClient
      .from('workspace_members')
      .insert({
        workspace_id: workspaceId,
        user_id: targetUserId,
        role: 'editor',
        invited_by: currentUserId,
      });

    if (insertErr) return { error: insertErr.message };

    await fetchMembers();
    return { error: null };
  }, [workspaceId, currentUserId, members, fetchMembers]);

  const removeMember = useCallback(async (memberId: string) => {
    await backendClient
      .from('workspace_members')
      .delete()
      .eq('id', memberId);
    setMembers(prev => prev.filter(m => m.id !== memberId));
  }, [setMembers]);

  const updateMemberRole = useCallback(async (memberId: string, role: Extract<WorkspaceMemberRole, 'editor' | 'viewer'>) => {
    await backendClient
      .from('workspace_members')
      .update({ role })
      .eq('id', memberId);
    setMembers(prev =>
      prev.map(m => m.id === memberId ? { ...m, role } : m)
    );
  }, [setMembers]);

  return {
    members,
    autoShare,
    loading,
    toggleAutoShare,
    inviteByEmail,
    removeMember,
    updateMemberRole,
    refreshMembers: fetchMembers,
  };
}
