// External-runtime ("club") client helpers. Pure transforms live alongside the thin
// REST wrappers so the display/selection logic can be unit-tested without a network.
import { apiAuthHeaders, apiUrl } from './backendClient';
import type { AgentRuntime, AgentRunMode } from '../types';

export interface JoinTokenResult {
  token: string;
  autoApprove: boolean;
  endpoint: string;
  config: unknown;
  claudeMcpAdd: string;
}

// --- pure transforms (unit-tested) -----------------------------------------

export function runtimeStatusLabel(status: AgentRuntime['status']): string {
  switch (status) {
    case 'approved': return 'Approved';
    case 'pending': return 'Pending approval';
    case 'revoked': return 'Revoked';
    default: return String(status);
  }
}

export function describeRunMode(mode: AgentRunMode | undefined): string {
  switch (mode) {
    case 'daemon': return 'Remote daemon';
    case 'external': return 'External runtime';
    case 'builtin':
    default: return 'Built-in';
  }
}

// Presence: trust the server-computed `online` flag when present, otherwise derive it
// from last_seen_at against the same TTL the backend uses (40s).
export const RUNTIME_PRESENCE_TTL_MS = 40_000;
export function isRuntimeOnline(runtime: Pick<AgentRuntime, 'online' | 'last_seen_at'>, nowMs = Date.now()): boolean {
  if (typeof runtime.online === 'boolean') return runtime.online;
  if (!runtime.last_seen_at) return false;
  const seen = Date.parse(runtime.last_seen_at);
  return Number.isFinite(seen) && (nowMs - seen) < RUNTIME_PRESENCE_TTL_MS;
}

// Only approved runtimes can back an agent — these are the choices the mapping UI offers.
export interface RuntimeOption { value: string; label: string; online: boolean; }
export function runtimeOptionsForAgent(runtimes: AgentRuntime[], nowMs = Date.now()): RuntimeOption[] {
  return runtimes
    .filter((r) => r.status === 'approved')
    .map((r) => ({
      value: r.id,
      label: `${r.name}${isRuntimeOnline(r, nowMs) ? ' • online' : ''}`,
      online: isRuntimeOnline(r, nowMs),
    }));
}

// --- REST wrappers ----------------------------------------------------------

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const message = (body && body.error && (body.error.message || body.error)) || `Request failed (${res.status})`;
    throw new Error(String(message));
  }
  return body?.data ?? body;
}

export async function fetchRuntimes(workspaceId: string): Promise<AgentRuntime[]> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/runtimes`), {
    headers: apiAuthHeaders(),
  });
  const data = await jsonOrThrow(res);
  return (data?.runtimes ?? []) as AgentRuntime[];
}

export async function createJoinToken(workspaceId: string): Promise<JoinTokenResult> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/runtime-join-token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({}),
  });
  return (await jsonOrThrow(res)) as JoinTokenResult;
}

export async function setRuntimeAutoApprove(workspaceId: string, autoApprove: boolean): Promise<boolean> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/runtime-auto-approve`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({ autoApprove }),
  });
  const data = await jsonOrThrow(res);
  return Boolean(data?.autoApprove);
}

export async function setRuntimeStatus(runtimeId: string, action: 'approve' | 'revoke'): Promise<AgentRuntime> {
  const res = await fetch(apiUrl(`/backend/runtimes/${encodeURIComponent(runtimeId)}/${action}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({}),
  });
  const data = await jsonOrThrow(res);
  return data?.runtime as AgentRuntime;
}

export async function mapAgentRuntime(agentId: string, runtimeId: string | null): Promise<void> {
  const res = await fetch(apiUrl(`/backend/agents/${encodeURIComponent(agentId)}/runtime`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({ runtimeId }),
  });
  await jsonOrThrow(res);
}
