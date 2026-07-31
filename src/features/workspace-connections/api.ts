import { apiAuthHeaders, apiUrl } from '@/lib/backendClient';
import type {
  CreatedWorkspaceJoinLink,
  CreateWorkspaceJoinLinkInput,
  WorkspaceConnectionRole,
  WorkspaceJoinLink,
  WorkspaceMember,
} from './model';

type ApiEnvelope<T> = {
  data?: T | null;
  error?: string | { message?: string } | null;
};

function workspacePath(workspaceId: string, suffix: string): string {
  return `/backend/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

function errorMessage(payload: ApiEnvelope<unknown> | null, fallback: string): string {
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
  if (
    payload?.error
    && typeof payload.error === 'object'
    && typeof payload.error.message === 'string'
    && payload.error.message.trim()
  ) {
    return payload.error.message;
  }
  return fallback;
}

async function requestData<T>(
  path: string,
  init: RequestInit,
  fallbackError: string,
): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok) throw new Error(errorMessage(payload, fallbackError));
  if (payload?.data == null) throw new Error(fallbackError);
  return payload.data;
}

export async function listWorkspaceMembers(workspaceId: string): Promise<WorkspaceMember[]> {
  const data = await requestData<WorkspaceMember[]>(
    workspacePath(workspaceId, '/members'),
    { headers: apiAuthHeaders() },
    'Failed to load workspace members',
  );
  return Array.isArray(data) ? data : [];
}

export async function removeWorkspaceMember(workspaceId: string, memberId: string): Promise<void> {
  const response = await fetch(
    apiUrl(workspacePath(workspaceId, `/members/${encodeURIComponent(memberId)}`)),
    { method: 'DELETE', headers: apiAuthHeaders() },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ApiEnvelope<unknown> | null;
    throw new Error(errorMessage(payload, 'Failed to remove workspace member'));
  }
}

export async function updateWorkspaceMemberRole(
  workspaceId: string,
  memberId: string,
  role: WorkspaceConnectionRole,
): Promise<void> {
  const response = await fetch(
    apiUrl(workspacePath(workspaceId, `/members/${encodeURIComponent(memberId)}`)),
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({ role }),
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as ApiEnvelope<unknown> | null;
    throw new Error(errorMessage(payload, 'Failed to update workspace member role'));
  }
}

export async function listWorkspaceJoinLinks(workspaceId: string): Promise<WorkspaceJoinLink[]> {
  const data = await requestData<WorkspaceJoinLink[]>(
    workspacePath(workspaceId, '/join-links'),
    { headers: apiAuthHeaders() },
    'Failed to load join links',
  );
  return Array.isArray(data) ? data : [];
}

export async function createWorkspaceJoinLink(
  workspaceId: string,
  input: CreateWorkspaceJoinLinkInput,
): Promise<CreatedWorkspaceJoinLink> {
  return requestData<CreatedWorkspaceJoinLink>(
    workspacePath(workspaceId, '/join-links'),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
      body: JSON.stringify({
        audience: input.audience,
        role: input.role,
        label: input.label?.trim() || '',
      }),
    },
    'Failed to create join link',
  );
}

export async function revokeWorkspaceJoinLink(
  workspaceId: string,
  linkId: string,
): Promise<Pick<WorkspaceJoinLink, 'id' | 'workspace_id' | 'status' | 'expires_at'> | null> {
  const response = await fetch(
    apiUrl(workspacePath(workspaceId, `/join-links/${encodeURIComponent(linkId)}`)),
    { method: 'DELETE', headers: apiAuthHeaders() },
  );
  const payload = await response.json().catch(() => null) as ApiEnvelope<
    Pick<WorkspaceJoinLink, 'id' | 'workspace_id' | 'status' | 'expires_at'>
  > | null;
  if (!response.ok) throw new Error(errorMessage(payload, 'Failed to revoke join link'));
  return payload?.data ?? null;
}
