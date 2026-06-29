import { useWorkspaceUsers } from '../../hooks/useWorkspaceUsers';
import { UsersWindowContent } from './UsersWindowContent';

interface UsersWindowProps {
  workspaceId: string;
  workspaceName: string;
  currentUserId?: string;
  currentUserEmail?: string;
}

// Data wrapper: owns the members/invites state for one workspace so the window
// render path stays free of prop drilling. The presentational UI is in
// UsersWindowContent.
export function UsersWindow({ workspaceId, workspaceName, currentUserId, currentUserEmail }: UsersWindowProps) {
  const { members, invites, loading, createInvite, revokeInvite, removeMember, changeMemberRole } =
    useWorkspaceUsers(workspaceId || null);
  const inviteOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <UsersWindowContent
      workspaceName={workspaceName}
      currentUserId={currentUserId}
      currentUserEmail={currentUserEmail}
      inviteOrigin={inviteOrigin}
      members={members}
      invites={invites}
      loading={loading}
      onCreateInvite={createInvite}
      onRevokeInvite={revokeInvite}
      onRemoveMember={removeMember}
      onChangeMemberRole={changeMemberRole}
    />
  );
}

export default UsersWindow;
