export const WORKSPACE_CONNECTION_ROLES = ['admin', 'editor', 'commenter', 'viewer'] as const;
export const JOIN_LINK_AUDIENCES = ['both', 'human', 'agent', 'controller'] as const;
export const WORKSPACE_CONTROLLER_SCOPES = [
  'agents:register',
  'agents:manage_own',
  'resources:create',
  'resources:manage_own',
] as const;

export type WorkspaceConnectionRole = typeof WORKSPACE_CONNECTION_ROLES[number];
export type WorkspaceMemberRole = 'owner' | WorkspaceConnectionRole;
export type JoinLinkAudience = typeof JOIN_LINK_AUDIENCES[number];
export type JoinLinkGrantKind = 'individual' | 'workspace_control';
export type WorkspaceControllerScope = typeof WORKSPACE_CONTROLLER_SCOPES[number];
export type JoinLinkStatus = 'pending' | 'redeemed' | 'revoked';
export type JoinLinkLifecycleState = JoinLinkStatus | 'expired';

export interface WorkspaceMember {
  id: string | null;
  user_id: string;
  email: string;
  role: WorkspaceMemberRole;
  invited_by: string | null;
  created_at: string;
}

export interface WorkspaceJoinLink {
  id: string;
  workspace_id: string;
  label: string;
  role: WorkspaceConnectionRole;
  grant_kind: JoinLinkGrantKind;
  audience: JoinLinkAudience;
  status: JoinLinkStatus;
  controller_name: string;
  controller_scopes: WorkspaceControllerScope[];
  controller_expires_at: string | null;
  redeemed_as: 'human' | 'agent' | 'controller' | null;
  redeemed_by: string | null;
  redeemed_agent_id: string | null;
  redeemed_controller_id: string | null;
  redeemed_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_by_email: string | null;
  created_at: string;
}

export interface CreatedWorkspaceJoinLink {
  id: string;
  workspace_id: string;
  label: string;
  role: WorkspaceConnectionRole;
  grant_kind: JoinLinkGrantKind;
  audience: JoinLinkAudience;
  status: JoinLinkStatus;
  controller_name: string;
  controller_scopes: WorkspaceControllerScope[];
  controller_expires_at: string | null;
  expires_at: string | null;
  created_by: string | null;
  created_at: string;
  /** Returned by the server once. It is never stored in the list response. */
  url: string;
  expiresInMs: number;
  credentialExpiresInMs?: number;
  singleUse: true;
}

export interface CreateWorkspaceJoinLinkInput {
  role: WorkspaceConnectionRole;
  audience: JoinLinkAudience;
  label?: string;
  grantKind?: JoinLinkGrantKind;
  controllerName?: string;
  scopes?: WorkspaceControllerScope[];
}

export interface WorkspaceController {
  id: string;
  workspace_id: string;
  name: string;
  scopes: WorkspaceControllerScope[];
  status: 'active' | 'revoked';
  parent_controller_id: string | null;
  expires_at: string | null;
  last_used_at: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
  revoked_at: string | null;
}

export function canManageWorkspace(members: WorkspaceMember[], currentUserId?: string): boolean {
  if (!currentUserId) return false;
  return members.some(member =>
    member.user_id === currentUserId
    && (member.role === 'owner' || member.role === 'admin'));
}

export function isWorkspaceOwner(members: WorkspaceMember[], currentUserId?: string): boolean {
  if (!currentUserId) return false;
  return members.some(member => member.user_id === currentUserId && member.role === 'owner');
}

export function joinLinkLifecycleState(
  link: WorkspaceJoinLink,
  now = Date.now(),
): JoinLinkLifecycleState {
  if (link.status === 'redeemed') return 'redeemed';
  if (link.status === 'revoked') return 'revoked';
  if (link.status !== 'pending') return 'revoked';

  const expiresAt = link.expires_at ? new Date(link.expires_at).getTime() : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt <= now ? 'expired' : 'pending';
}

export function joinLinkAudienceLabel(audience: JoinLinkAudience): string {
  if (audience === 'human') return 'person only';
  if (audience === 'agent') return 'agent only';
  if (audience === 'controller') return 'workspace controller';
  return 'person or agent';
}

export function joinLinkRedeemedAsLabel(link: WorkspaceJoinLink): string {
  if (link.redeemed_as === 'human') return 'redeemed as person';
  if (link.redeemed_as === 'agent') return 'redeemed as agent';
  if (link.redeemed_as === 'controller') return 'enrolled as controller';
  return 'redeemed';
}
