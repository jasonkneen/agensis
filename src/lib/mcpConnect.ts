// Client helpers for Settings → Connections: load MCP connection status,
// mint/rotate the workspace control credential, and toggle auto-approve.
//
// The live bearer is returned ONLY from POST mint/rotate. Status never includes
// it — only a hash is stored — so the UI can show endpoint + recipes immediately
// without rotating the credential on every open.
import { apiAuthHeaders, apiUrl } from './backendClient';

export interface McpConnectInfo {
  /** Present only immediately after mint/rotate. */
  token?: string;
  configured: boolean;
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

function normalizeMcpInfo(raw: Record<string, unknown> | null | undefined): McpConnectInfo {
  const data = raw || {};
  return {
    token: typeof data.token === 'string' && data.token ? data.token : undefined,
    configured: Boolean(data.configured) || Boolean(data.token),
    autoApprove: Boolean(data.autoApprove),
    endpoint: String(data.endpoint || ''),
    config: data.config ?? null,
    claudeMcpAdd: String(data.claudeMcpAdd || ''),
  };
}

/** Owner-only status: endpoint, recipes, whether a credential is issued. No secret. */
export async function getMcpConnection(workspaceId: string): Promise<McpConnectInfo> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/mcp-connection`), {
    method: 'GET',
    headers: { ...apiAuthHeaders() },
  });
  return normalizeMcpInfo(await jsonOrThrow(res));
}

/** Mint or rotate the workspace control credential. Returns the live token once. */
export async function generateMcpToken(workspaceId: string): Promise<McpConnectInfo> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/mcp-token`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({}),
  });
  return normalizeMcpInfo(await jsonOrThrow(res));
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

/** OAuth 2.1 fields any MCP client needs (not product-specific). */
export interface McpOauthCatalog {
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
  scopes: string[];
  tokenEndpointAuthMethods: string[];
  clients: McpOauthClientSummary[];
}

export interface McpOauthClientSummary {
  id: string;
  clientId: string;
  name: string;
  tokenEndpointAuthMethod: string;
  redirectUris: string[];
  scopes: string[];
  hasSecret: boolean;
  createdAt?: string;
}

export interface McpOauthClientMinted extends McpOauthClientSummary {
  clientSecret: string | null;
  resource: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string;
}

export async function getMcpOauthCatalog(workspaceId: string): Promise<McpOauthCatalog> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/oauth-clients`), {
    method: 'GET',
    headers: { ...apiAuthHeaders() },
  });
  const data = await jsonOrThrow(res) as Record<string, unknown>;
  return {
    resource: String(data.resource || ''),
    authorizationEndpoint: String(data.authorizationEndpoint || ''),
    tokenEndpoint: String(data.tokenEndpoint || ''),
    registrationEndpoint: String(data.registrationEndpoint || ''),
    scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : ['mcp:tools'],
    tokenEndpointAuthMethods: Array.isArray(data.tokenEndpointAuthMethods)
      ? data.tokenEndpointAuthMethods.map(String)
      : ['none'],
    clients: Array.isArray(data.clients) ? (data.clients as McpOauthClientSummary[]) : [],
  };
}

export async function createMcpOauthClient(
  workspaceId: string,
  input: {
    name?: string;
    tokenEndpointAuthMethod?: string;
    redirectUris?: string[];
  } = {},
): Promise<McpOauthClientMinted> {
  const res = await fetch(apiUrl(`/backend/workspaces/${encodeURIComponent(workspaceId)}/oauth-clients`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...apiAuthHeaders() },
    body: JSON.stringify({
      name: input.name || 'MCP OAuth client',
      token_endpoint_auth_method: input.tokenEndpointAuthMethod || 'none',
      redirect_uris: input.redirectUris,
    }),
  });
  const data = await jsonOrThrow(res) as Record<string, unknown>;
  return {
    id: String(data.clientId || ''),
    clientId: String(data.clientId || ''),
    clientSecret: typeof data.clientSecret === 'string' ? data.clientSecret : null,
    name: String(data.name || 'MCP OAuth client'),
    tokenEndpointAuthMethod: String(data.tokenEndpointAuthMethod || 'none'),
    redirectUris: Array.isArray(data.redirectUris) ? data.redirectUris.map(String) : [],
    scopes: Array.isArray(data.scopes) ? data.scopes.map(String) : ['mcp:tools'],
    hasSecret: Boolean(data.clientSecret),
    resource: String(data.resource || ''),
    authorizationEndpoint: String(data.authorizationEndpoint || ''),
    tokenEndpoint: String(data.tokenEndpoint || ''),
    registrationEndpoint: String(data.registrationEndpoint || ''),
  };
}
