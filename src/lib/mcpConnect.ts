// Client helpers for the "Connect an MCP client" flow: mint the one workspace MCP token
// and toggle auto-approve. The token is what a client puts in its MCP config; it then
// calls register_agent to become an agent (approved via popup, or auto when toggled on).
import { apiAuthHeaders, apiUrl } from './backendClient';

export interface McpConnectInfo {
  token: string;
  autoApprove: boolean;
  endpoint: string;
  config: unknown;
  claudeMcpAdd: string;
}

async function jsonOrThrow(res: Response) {
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error((body && body.error && (body.error.message || body.error)) || `Request failed (${res.status})`);
  return body?.data ?? body;
}

export async function generateMcpToken(workspaceId: string): Promise<McpConnectInfo> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/mcp-token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({}),
  });
  return (await jsonOrThrow(res)) as McpConnectInfo;
}

export async function setMcpAutoApprove(workspaceId: string, autoApprove: boolean): Promise<boolean> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/mcp-auto-approve`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({ autoApprove }),
  });
  const data = await jsonOrThrow(res);
  return Boolean(data?.autoApprove);
}
