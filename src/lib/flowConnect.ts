import { apiAuthHeaders, apiUrl } from './backendClient';

export interface FlowConnectionInfo {
  id: string;
  name: string;
  workspaceId: string;
  channelId: string | null;
  endpoint: string;
  token: string;
  signingSecret: string;
  webhookUrl: string | null;
  events: string[];
  scopes: string[];
}

async function jsonOrThrow(response: Response) {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error?.message || payload?.error || `Agensis returned HTTP ${response.status}`);
  }
  return payload?.data ?? payload;
}

export async function createFlowConnection(input: {
  workspaceId: string;
  channelId?: string | null;
  name?: string;
  webhookUrl?: string;
}): Promise<FlowConnectionInfo> {
  const response = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(input.workspaceId)}/flow-connections`), {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({
      channelId: input.channelId || null,
      name: input.name || 'Flows',
      webhookUrl: input.webhookUrl?.trim() || null,
    }),
  });
  return (await jsonOrThrow(response)) as FlowConnectionInfo;
}
