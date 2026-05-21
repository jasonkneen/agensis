import { useState, useEffect, useCallback } from 'react';
import { backendClient } from '../lib/backendClient';

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: 'owner' | 'editor' | 'viewer';
  invited_by: string | null;
  created_at: string;
  email?: string;
}

export function useSharing(workspaceId: string | null, currentUserId: string | undefined) {
  const [members, setMembers] = useState<WorkspaceMember[]>([]);
  const [autoShare, setAutoShareState] = useState(false);
  const [loading, setLoading] = useState(false);

  const fetchMembers = useCallback(async () => {
    if (!workspaceId) return;
    setLoading(true);

    const { data } = await backendClient
      .from('workspace_members')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('created_at', { ascending: true });

    if (data) setMembers(data);
    setLoading(false);
  }, [workspaceId]);

  const fetchAutoShare = useCallback(async () => {
    if (!workspaceId) return;
    const { data } = await backendClient
      .from('workspaces')
      .select('auto_share')
      .eq('id', workspaceId)
      .maybeSingle();
    if (data) setAutoShareState(data.auto_share ?? false);
  }, [workspaceId]);

  useEffect(() => {
    fetchMembers();
    fetchAutoShare();
  }, [fetchMembers, fetchAutoShare]);

  const toggleAutoShare = useCallback(async () => {
    if (!workspaceId) return;
    const newValue = !autoShare;
    setAutoShareState(newValue);
    const { error } = await backendClient
      .from('workspaces')
      .update({ auto_share: newValue })
      .eq('id', workspaceId);

    if (error) {
      setAutoShareState(!newValue);
      return;
    }

    await fetchAutoShare();
  }, [workspaceId, autoShare, fetchAutoShare]);

  const inviteByEmail = useCallback(async (email: string): Promise<{ error: string | null }> => {
    if (!workspaceId || !currentUserId) return { error: 'Not ready' };

    const { data: users, error: lookupErr } = await backendClient
      .rpc('lookup_user_by_email', { lookup_email: email });

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
  }, []);

  const updateMemberRole = useCallback(async (memberId: string, role: 'editor' | 'viewer') => {
    await backendClient
      .from('workspace_members')
      .update({ role })
      .eq('id', memberId);
    setMembers(prev =>
      prev.map(m => m.id === memberId ? { ...m, role } : m)
    );
  }, []);

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
