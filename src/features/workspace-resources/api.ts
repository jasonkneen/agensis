import { apiAuthHeaders, apiUrl } from '@/lib/backendClient';
import type {
  CreateWorkspaceResourceInput,
  RequestWorkspaceResourceOperationInput,
  WorkspaceResource,
  WorkspaceResourceOperation,
} from './model';

type ApiEnvelope<T> = {
  data?: T | null;
  error?: string | { message?: string } | null;
};

function workspacePath(workspaceId: string, suffix: string): string {
  return `/backend/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

export function workspaceResourceErrorMessage(
  payload: ApiEnvelope<unknown> | null,
  status: number,
  fallback: string,
): string {
  if (typeof payload?.error === 'string' && payload.error.trim()) return payload.error;
  if (
    payload?.error
    && typeof payload.error === 'object'
    && typeof payload.error.message === 'string'
    && payload.error.message.trim()
  ) return payload.error.message;
  if (status === 403) return 'You do not have permission to manage this workspace resource.';
  return fallback;
}

async function requestData<T>(path: string, init: RequestInit, fallback: string): Promise<T> {
  const response = await fetch(apiUrl(path), init);
  const payload = await response.json().catch(() => null) as ApiEnvelope<T> | null;
  if (!response.ok) throw new Error(workspaceResourceErrorMessage(payload, response.status, fallback));
  if (payload?.data == null) throw new Error(fallback);
  return payload.data;
}

export async function listWorkspaceResources(workspaceId: string): Promise<WorkspaceResource[]> {
  const data = await requestData<WorkspaceResource[]>(
    workspacePath(workspaceId, '/resources?status=all&limit=200'),
    { headers: apiAuthHeaders() },
    'Could not load workspace resources.',
  );
  return Array.isArray(data) ? data : [];
}

export async function createWorkspaceResource(
  workspaceId: string,
  input: CreateWorkspaceResourceInput,
): Promise<WorkspaceResource> {
  return requestData<WorkspaceResource>(
    workspacePath(workspaceId, '/resources'),
    {
      method: 'POST',
      headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        stewardAgentId: input.stewardAgentId,
        definition: {
          name: input.name,
          description: input.description || '',
          facet: input.facet,
          visibility: input.visibility || 'workspace',
          descriptor: input.descriptor || {},
        },
      }),
    },
    'Could not create the workspace resource.',
  );
}

export async function updateWorkspaceResource(
  workspaceId: string,
  resourceId: string,
  changes: Partial<Pick<WorkspaceResource, 'name' | 'description' | 'visibility' | 'status'>>,
): Promise<WorkspaceResource> {
  return requestData<WorkspaceResource>(
    workspacePath(workspaceId, `/resources/${encodeURIComponent(resourceId)}`),
    {
      method: 'PATCH',
      headers: { ...apiAuthHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ changes }),
    },
    'Could not update the workspace resource.',
  );
}

export async function listWorkspaceResourceOperations(
  workspaceId: string,
): Promise<WorkspaceResourceOperation[]> {
  const data = await requestData<WorkspaceResourceOperation[]>(
    workspacePath(workspaceId, '/resource-operations?status=all&limit=100'),
    { headers: apiAuthHeaders() },
    'Could not load resource operations.',
  );
  return Array.isArray(data) ? data : [];
}

export async function getWorkspaceResourceOperation(
  workspaceId: string,
  operationId: string,
): Promise<WorkspaceResourceOperation> {
  return requestData<WorkspaceResourceOperation>(
    workspacePath(
      workspaceId,
      `/resource-operations/${encodeURIComponent(operationId)}?includeArtifacts=true`,
    ),
    { headers: apiAuthHeaders() },
    'Could not load the resource operation.',
  );
}

export async function requestWorkspaceResourceOperation(
  workspaceId: string,
  resourceId: string,
  input: RequestWorkspaceResourceOperationInput,
): Promise<WorkspaceResourceOperation> {
  return requestData<WorkspaceResourceOperation>(
    workspacePath(workspaceId, `/resources/${encodeURIComponent(resourceId)}/operations`),
    {
      method: 'POST',
      headers: {
        ...apiAuthHeaders(),
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        operation: input.operation,
        inputArtifact: input.inputArtifact || {},
      }),
    },
    'Could not request the resource operation.',
  );
}
