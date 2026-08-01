import type { WorkspaceAgent } from '@/types';
import {
  RESOURCE_FACET_LABELS,
  RESOURCE_FACETS,
  normalizeResourceFacets,
  type ResourceFacet,
} from '@/lib/agentPurpose';

export type WorkspaceResourceVisibility = 'workspace' | 'restricted';
export type WorkspaceResourceStatus = 'active' | 'archived';
export type WorkspaceResourceOperationKind = 'read' | 'propose' | 'apply' | 'publish';
export type WorkspaceResourceOperationStatus =
  | 'pending'
  | 'claimed'
  | 'completed'
  | 'rejected'
  | 'failed'
  | 'cancelled';
export type WorkspaceResourceOperationProgressPhase =
  | 'queued'
  | 'planning'
  | 'executing'
  | 'verifying'
  | 'waiting'
  | 'completed'
  | 'rejected'
  | 'failed';
export type WorkspaceResourceOperationStepStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';

export interface WorkspaceResourceOperationProgress {
  phase: WorkspaceResourceOperationProgressPhase;
  message: string;
  stepId: string | null;
  stepStatus: WorkspaceResourceOperationStepStatus | null;
  percent: number | null;
}

export interface WorkspaceResource {
  id: string;
  workspace_id: string;
  steward_agent_id: string;
  controller_id: string | null;
  name: string;
  description: string;
  facet: ResourceFacet;
  descriptor: Record<string, unknown>;
  version: number;
  visibility: WorkspaceResourceVisibility;
  status: WorkspaceResourceStatus;
  deleted_at: string | null;
  created_by: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WorkspaceResourceOperation {
  id: string;
  workspace_id: string;
  resource_id: string;
  steward_agent_id: string;
  requested_by_user_id: string | null;
  requested_by_agent_id: string | null;
  requested_by_controller_id: string | null;
  claimed_by_agent_id: string | null;
  operation: WorkspaceResourceOperationKind;
  status: WorkspaceResourceOperationStatus;
  resource_version: number;
  error: string;
  progress: WorkspaceResourceOperationProgress | Record<string, unknown>;
  progress_seq: number;
  progress_updated_at: string | null;
  audit_reference: string | null;
  created_at: string | null;
  updated_at: string | null;
  claimed_at: string | null;
  completed_at: string | null;
  input_artifact?: Record<string, unknown>;
  output_artifact?: Record<string, unknown>;
}

export interface CreateWorkspaceResourceInput {
  stewardAgentId: string;
  name: string;
  description?: string;
  facet: ResourceFacet;
  visibility?: WorkspaceResourceVisibility;
  descriptor?: Record<string, unknown>;
}

export interface RequestWorkspaceResourceOperationInput {
  operation: WorkspaceResourceOperationKind;
  requestText?: string;
  inputArtifact?: Record<string, unknown>;
  steps?: Array<{
    id: string;
    instruction: string;
    dependsOn?: string[];
  }>;
  stopOnError?: boolean;
  idempotencyKey: string;
}

export const RESOURCE_OPERATION_LABELS: Record<WorkspaceResourceOperationKind, string> = {
  read: 'Read',
  propose: 'Propose change',
  apply: 'Apply change',
  publish: 'Publish',
};

export const RESOURCE_OPERATION_STATUS_LABELS: Record<WorkspaceResourceOperationStatus, string> = {
  pending: 'Waiting for steward',
  claimed: 'Steward working',
  completed: 'Completed',
  rejected: 'Rejected',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function resourceFacetLabel(facet: ResourceFacet): string {
  return RESOURCE_FACET_LABELS[facet] ?? facet;
}

export const RESOURCE_OPERATION_KINDS: WorkspaceResourceOperationKind[] = [
  'read',
  'propose',
  'apply',
  'publish',
];

/**
 * Resource access is carried by the steward's normal tool surface. These are
 * capability families for the UI, not invented per-resource tool identifiers.
 * The actual call is relayed to the steward agent (or its connected CLI), so
 * its ordinary read/write/list/shell tools remain the authority.
 */
export const RESOURCE_STEWARD_CAPABILITIES = ['read', 'write', 'list', 'bash', 'grep'] as const;
export type ResourceStewardCapability = typeof RESOURCE_STEWARD_CAPABILITIES[number];

export function resourceStewardCandidates(
  agents: WorkspaceAgent[],
  facet?: ResourceFacet | null,
): WorkspaceAgent[] {
  return agents
    .filter(agent => agent.enabled !== false && agent.purpose === 'resource')
    .filter(agent => !facet || normalizeResourceFacets(agent.resource_facets).includes(facet))
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function resourceAgentFacetSummary(agent: WorkspaceAgent): string {
  return normalizeResourceFacets(agent.resource_facets)
    .map(resourceFacetLabel)
    .join(', ');
}

export function isLiveResourceOperation(operation: WorkspaceResourceOperation): boolean {
  return operation.status === 'pending' || operation.status === 'claimed';
}

export function operationProgress(
  operation: WorkspaceResourceOperation | null,
): WorkspaceResourceOperationProgress | null {
  const value = operation?.progress;
  if (!value || typeof value !== 'object') return null;
  const phase = value.phase;
  const message = value.message;
  if (typeof phase !== 'string' || typeof message !== 'string' || !message.trim()) return null;
  return {
    phase: phase as WorkspaceResourceOperationProgressPhase,
    message,
    stepId: typeof value.stepId === 'string' ? value.stepId : null,
    stepStatus: typeof value.stepStatus === 'string' ? value.stepStatus as WorkspaceResourceOperationStepStatus : null,
    percent: typeof value.percent === 'number' ? value.percent : null,
  };
}

export function operationsForResource(
  operations: WorkspaceResourceOperation[],
  resourceId: string | null,
): WorkspaceResourceOperation[] {
  if (!resourceId) return [];
  return operations
    .filter(operation => operation.resource_id === resourceId)
    .sort((left, right) => Date.parse(right.created_at || '') - Date.parse(left.created_at || ''));
}

/**
 * Keep detail responses useful without allowing a polling snapshot to become
 * stale. The list endpoint is intentionally compact, while a selected detail
 * may include input/output artifacts. Merge the fresh list fields over the
 * cached detail so status/lease fields advance on every refresh but the richer
 * artifact payload remains available for the selected operation.
 */
export function mergeResourceOperationDetails(
  details: Record<string, WorkspaceResourceOperation>,
  operations: WorkspaceResourceOperation[],
): Record<string, WorkspaceResourceOperation> {
  let changed = false;
  const next = { ...details };
  for (const operation of operations) {
    const existing = details[operation.id];
    if (!existing) continue;
    next[operation.id] = { ...existing, ...operation };
    changed = true;
  }
  return changed ? next : details;
}

export function parseResourceJsonObject(value: string): Record<string, unknown> {
  const trimmed = value.trim();
  if (!trimmed) return {};
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Input must be a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

export function newResourceOperationKey(resourceId: string, now = Date.now()): string {
  const random = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `ui:${resourceId}:${now}:${random}`;
}

export { RESOURCE_FACETS };
export type { ResourceFacet };
