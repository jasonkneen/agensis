import { describe, expect, it } from 'vitest';
import type { WorkspaceAgent } from '../../src/types';
import {
  isLiveResourceOperation,
  mergeResourceOperationDetails,
  operationsForResource,
  parseResourceJsonObject,
  resourceOperationToolName,
  resourceStewardCandidates,
  resourceToolSlug,
  type WorkspaceResourceOperation,
} from '../../src/features/workspace-resources';

function agent(overrides: Partial<WorkspaceAgent>): WorkspaceAgent {
  return {
    id: 'agent-1',
    workspace_id: 'workspace-1',
    name: 'Agent',
    avatar: '',
    description: '',
    system_prompt: '',
    model: 'configured-by-agent',
    enabled: true,
    ...overrides,
  } as WorkspaceAgent;
}

function operation(overrides: Partial<WorkspaceResourceOperation>): WorkspaceResourceOperation {
  return {
    id: 'operation-1',
    workspace_id: 'workspace-1',
    resource_id: 'resource-1',
    steward_agent_id: 'steward-1',
    requested_by_user_id: 'user-1',
    requested_by_agent_id: null,
    requested_by_controller_id: null,
    claimed_by_agent_id: null,
    operation: 'read',
    status: 'pending',
    resource_version: 1,
    error: '',
    audit_reference: null,
    created_at: '2026-07-31T12:00:00.000Z',
    updated_at: '2026-07-31T12:00:00.000Z',
    claimed_at: null,
    completed_at: null,
    ...overrides,
  };
}

describe('workspace resource view model', () => {
  it('offers only enabled resource-purpose stewards that support the selected facet', () => {
    const agents = [
      agent({ id: 'collaborator', name: 'Collaborator', purpose: 'collaborator', resource_facets: [] }),
      agent({ id: 'code', name: 'Code steward', purpose: 'resource', resource_facets: ['code', 'tooling'] }),
      agent({ id: 'knowledge', name: 'Knowledge steward', purpose: 'resource', resource_facets: ['knowledge'] }),
      agent({ id: 'disabled', name: 'Disabled', purpose: 'resource', resource_facets: ['code'], enabled: false }),
    ];

    expect(resourceStewardCandidates(agents, 'code').map(entry => entry.id)).toEqual(['code']);
    expect(resourceStewardCandidates(agents).map(entry => entry.id)).toEqual(['code', 'knowledge']);
  });

  it('keeps only the selected resource operations and orders newest first', () => {
    const rows = [
      operation({ id: 'old', created_at: '2026-07-31T11:00:00.000Z' }),
      operation({ id: 'other', resource_id: 'resource-2', created_at: '2026-07-31T13:00:00.000Z' }),
      operation({ id: 'new', created_at: '2026-07-31T12:00:00.000Z' }),
    ];
    expect(operationsForResource(rows, 'resource-1').map(entry => entry.id)).toEqual(['new', 'old']);
    expect(operationsForResource(rows, null)).toEqual([]);
  });

  it('slugifies a resource name into a tool-name-safe token', () => {
    expect(resourceToolSlug('Repository index')).toBe('repository_index');
    expect(resourceToolSlug('  test  ')).toBe('test');
    expect(resourceToolSlug('acme/product-v2')).toBe('acme_product_v2');
    expect(resourceToolSlug('!!!')).toBe('resource');
  });

  it('derives the per-verb tool name from a resource name', () => {
    expect(resourceOperationToolName('test', 'read')).toBe('test_read');
    expect(resourceOperationToolName('Repository index', 'apply')).toBe('repository_index_apply');
  });

  it('polls only genuinely live operations', () => {
    expect(isLiveResourceOperation(operation({ status: 'pending' }))).toBe(true);
    expect(isLiveResourceOperation(operation({ status: 'claimed' }))).toBe(true);
    expect(isLiveResourceOperation(operation({ status: 'completed' }))).toBe(false);
    expect(isLiveResourceOperation(operation({ status: 'failed' }))).toBe(false);
  });

  it('advances cached detail status while preserving fetched artifacts', () => {
    const detail = operation({
      status: 'pending',
      input_artifact: { request: 'read the handbook' },
      output_artifact: { answer: 'old result' },
    });
    const next = operation({
      status: 'completed',
      updated_at: '2026-07-31T12:05:00.000Z',
    });
    const merged = mergeResourceOperationDetails({ [detail.id]: detail }, [next]);
    expect(merged[detail.id].status).toBe('completed');
    expect(merged[detail.id].updated_at).toBe(next.updated_at);
    expect(merged[detail.id].input_artifact).toEqual(detail.input_artifact);
    expect(merged[detail.id].output_artifact).toEqual(detail.output_artifact);
  });

  it('accepts only a JSON object for resource descriptors and operation artifacts', () => {
    expect(parseResourceJsonObject('')).toEqual({});
    expect(parseResourceJsonObject('{"branch":"main"}')).toEqual({ branch: 'main' });
    expect(() => parseResourceJsonObject('[]')).toThrow(/JSON object/i);
    expect(() => parseResourceJsonObject('"secret"')).toThrow(/JSON object/i);
    expect(() => parseResourceJsonObject('{')).toThrow();
  });
});
