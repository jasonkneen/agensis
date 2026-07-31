import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createWorkspaceJoinLink as createWorkspaceJoinLinkRequest,
  listWorkspaceJoinLinks,
  listWorkspaceMembers,
  removeWorkspaceMember as removeWorkspaceMemberRequest,
  revokeWorkspaceJoinLink as revokeWorkspaceJoinLinkRequest,
  updateWorkspaceMemberRole as updateWorkspaceMemberRoleRequest,
} from './api';
import {
  canManageWorkspace,
  type CreatedWorkspaceJoinLink,
  type CreateWorkspaceJoinLinkInput,
  type WorkspaceJoinLink,
  type WorkspaceMember,
} from './model';

type MembersState = {
  workspaceId: string | null;
  rows: WorkspaceMember[];
};

function listedJoinLink(created: CreatedWorkspaceJoinLink): WorkspaceJoinLink {
  return {
    id: created.id,
    workspace_id: created.workspace_id,
    label: created.label,
    role: created.role,
    audience: created.audience,
    status: created.status,
    redeemed_as: null,
    redeemed_by: null,
    redeemed_agent_id: null,
    redeemed_at: null,
    expires_at: created.expires_at,
    created_by: created.created_by,
    created_by_email: null,
    created_at: created.created_at,
  };
}

export function useWorkspaceConnections(workspaceId: string | null, currentUserId?: string) {
  const activeWorkspaceRef = useRef(workspaceId);
  activeWorkspaceRef.current = workspaceId;
  const memberRequestRef = useRef(0);
  const joinLinkRequestRef = useRef(0);
  const [membersState, setMembersState] = useState<MembersState>({ workspaceId: null, rows: [] });
  const [joinLinks, setJoinLinks] = useState<WorkspaceJoinLink[]>([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [joinLinksLoading, setJoinLinksLoading] = useState(false);
  const [error, setError] = useState('');

  const members = membersState.workspaceId === workspaceId ? membersState.rows : [];
  const canManage = canManageWorkspace(members, currentUserId);
  const membershipPending = Boolean(workspaceId) && membersState.workspaceId !== workspaceId;

  const refreshMembers = useCallback(async () => {
    const requestId = memberRequestRef.current + 1;
    memberRequestRef.current = requestId;
    if (!workspaceId) {
      setMembersState({ workspaceId: null, rows: [] });
      setMembersLoading(false);
      return;
    }

    setMembersLoading(true);
    setError('');
    try {
      const rows = await listWorkspaceMembers(workspaceId);
      if (memberRequestRef.current !== requestId || activeWorkspaceRef.current !== workspaceId) return;
      setMembersState({ workspaceId, rows });
    } catch (requestError) {
      if (memberRequestRef.current !== requestId || activeWorkspaceRef.current !== workspaceId) return;
      setMembersState({ workspaceId, rows: [] });
      setError(requestError instanceof Error ? requestError.message : 'Failed to load workspace members');
    } finally {
      if (memberRequestRef.current === requestId) setMembersLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void refreshMembers();
  }, [refreshMembers]);

  const refreshJoinLinks = useCallback(async () => {
    const requestId = joinLinkRequestRef.current + 1;
    joinLinkRequestRef.current = requestId;
    if (!workspaceId || !canManage) {
      setJoinLinks([]);
      setJoinLinksLoading(false);
      return;
    }

    setJoinLinksLoading(true);
    setError('');
    try {
      const rows = await listWorkspaceJoinLinks(workspaceId);
      if (joinLinkRequestRef.current !== requestId || activeWorkspaceRef.current !== workspaceId) return;
      setJoinLinks(rows);
    } catch (requestError) {
      if (joinLinkRequestRef.current !== requestId || activeWorkspaceRef.current !== workspaceId) return;
      setJoinLinks([]);
      setError(requestError instanceof Error ? requestError.message : 'Failed to load join links');
    } finally {
      if (joinLinkRequestRef.current === requestId) setJoinLinksLoading(false);
    }
  }, [canManage, workspaceId]);

  useEffect(() => {
    void refreshJoinLinks();
  }, [refreshJoinLinks]);

  const createJoinLink = useCallback(async (
    input: CreateWorkspaceJoinLinkInput,
  ): Promise<CreatedWorkspaceJoinLink> => {
    if (!workspaceId || !canManage) throw new Error('Only workspace owners and admins can create join links');
    setError('');
    try {
      const created = await createWorkspaceJoinLinkRequest(workspaceId, input);
      if (activeWorkspaceRef.current === workspaceId) {
        setJoinLinks(previous => [listedJoinLink(created), ...previous]);
      }
      return created;
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Failed to create join link';
      setError(message);
      throw new Error(message);
    }
  }, [canManage, workspaceId]);

  const revokeJoinLink = useCallback(async (linkId: string): Promise<void> => {
    if (!workspaceId || !canManage) throw new Error('Only workspace owners and admins can revoke join links');
    setError('');
    try {
      const revoked = await revokeWorkspaceJoinLinkRequest(workspaceId, linkId);
      if (activeWorkspaceRef.current !== workspaceId) return;
      if (!revoked) {
        await refreshJoinLinks();
        return;
      }
      setJoinLinks(previous => previous.map(link =>
        link.id === linkId ? { ...link, status: 'revoked' } : link));
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Failed to revoke join link';
      setError(message);
      throw new Error(message);
    }
  }, [canManage, refreshJoinLinks, workspaceId]);

  const removeMember = useCallback(async (memberId: string): Promise<void> => {
    if (!workspaceId || !canManage) throw new Error('Only workspace owners and admins can remove members');
    setError('');
    try {
      await removeWorkspaceMemberRequest(workspaceId, memberId);
      if (activeWorkspaceRef.current === workspaceId) {
        setMembersState(previous => ({
          workspaceId,
          rows: previous.workspaceId === workspaceId
            ? previous.rows.filter(member => member.id !== memberId)
            : previous.rows,
        }));
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Failed to remove workspace member';
      setError(message);
      throw new Error(message);
    }
  }, [canManage, workspaceId]);

  const changeMemberRole = useCallback(async (
    memberId: string,
    role: WorkspaceJoinLink['role'],
  ): Promise<void> => {
    if (!workspaceId || !canManage) throw new Error('Only workspace owners and admins can change member roles');
    setError('');
    try {
      await updateWorkspaceMemberRoleRequest(workspaceId, memberId, role);
      if (activeWorkspaceRef.current === workspaceId) {
        setMembersState(previous => ({
          workspaceId,
          rows: previous.workspaceId === workspaceId
            ? previous.rows.map(member => member.id === memberId ? { ...member, role } : member)
            : previous.rows,
        }));
      }
    } catch (requestError) {
      const message = requestError instanceof Error ? requestError.message : 'Failed to update workspace member role';
      setError(message);
      throw new Error(message);
    }
  }, [canManage, workspaceId]);

  return {
    members,
    joinLinks,
    canManage,
    loading: membershipPending || membersLoading || joinLinksLoading,
    membersLoading: membershipPending || membersLoading,
    joinLinksLoading,
    error,
    refreshMembers,
    refreshJoinLinks,
    createJoinLink,
    revokeJoinLink,
    removeMember,
    changeMemberRole,
  };
}
