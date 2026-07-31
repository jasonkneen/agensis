import { useWorkspaceConnections } from '@/features/workspace-connections';
import { UsersWindowContent } from './UsersWindowContent';

interface UsersWindowProps {
  workspaceId: string;
  workspaceName: string;
  currentUserId?: string;
  currentUserEmail?: string;
}

// Data wrapper: owns the members/join-links state for one workspace so the
// render path stays free of prop drilling. The feature hook deliberately loads
// members first and never calls the manage-only join-link API for a non-manager.
export function UsersWindow({ workspaceId, workspaceName, currentUserId, currentUserEmail }: UsersWindowProps) {
  const {
    members,
    joinLinks,
    canManage,
    loading,
    error,
    createJoinLink,
    revokeJoinLink,
    removeMember,
    changeMemberRole,
  } = useWorkspaceConnections(workspaceId || null, currentUserId);

  return (
    <UsersWindowContent
      workspaceName={workspaceName}
      currentUserId={currentUserId}
      currentUserEmail={currentUserEmail}
      members={members}
      joinLinks={joinLinks}
      canManage={canManage}
      loading={loading}
      error={error}
      onCreateJoinLink={createJoinLink}
      onRevokeJoinLink={revokeJoinLink}
      onRemoveMember={removeMember}
      onChangeMemberRole={changeMemberRole}
    />
  );
}

export default UsersWindow;
