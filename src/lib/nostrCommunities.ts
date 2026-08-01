import { apiAuthHeaders, apiUrl } from './backendClient';

export interface NostrJoinPolicy {
  termsMarkdown: string;
  privacyMarkdown: string;
  ageAttestationRequired: boolean;
  version: string;
}

export interface NostrInvitePreview {
  host: string;
  httpUrl: string;
  wsUrl: string;
  name: string;
  description: string;
  relayPubkey: string;
  supportedNips: number[];
  policy: NostrJoinPolicy | null;
}

export interface NostrConnection {
  id: string;
  workspaceId: string;
  relayHttpUrl: string;
  relayWsUrl: string;
  communityId: string;
  host: string;
  name: string;
  description: string;
  relayPubkey: string;
  memberPubkey: string;
  policyVersion: string;
  status: string;
  lastError: string;
  subscriptions: NostrChannelSubscription[];
}

export interface NostrChannelSubscription {
  bridgeId: string;
  channelId: string;
  sessionId: string;
  enabled: boolean;
  status: string;
  lastError: string;
}

export interface NostrChannel {
  id: string;
  name: string;
  description: string;
  type: string;
  visibility: 'public' | 'private';
  archived: boolean;
  joined: boolean;
  subscription: NostrChannelSubscription | null;
}

export interface NostrMember {
  pubkey: string;
  channelId: string;
  name: string;
  handle: string;
  picture: string;
  isAgent: boolean;
  aliases: string[];
}

export interface NostrConnectResult {
  connection: NostrConnection;
  channels: NostrChannel[];
  alreadyConnected: boolean;
}

export class NostrRequestError extends Error {
  readonly status: number;
  readonly path: string;

  constructor(message: string, status: number, path: string) {
    super(message);
    this.name = 'NostrRequestError';
    this.status = status;
    this.path = path;
  }
}

/**
 * Keep the invite flow actionable when a deploy boundary is stale. A bare
 * `Request failed (404)` cannot tell an operator whether the Agensis route or
 * the remote NIP-29 host is missing, which is exactly the distinction needed
 * when a local UI is pointed at a separately deployed backend.
 */
export function nostrErrorMessage(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (!(reason instanceof NostrRequestError)) return message;

  const isPreview = reason.path === '/backend/nostr-communities/preview';
  const isRemoteRelayFailure = /Nostr relay|Nostr join policy|Nostr invite claim/i.test(message);
  if (reason.status === 404 && isPreview && isRemoteRelayFailure) {
    return 'The community host returned 404 for its Nostr metadata. Check that this invite URL is current and that the community relay is deployed.';
  }
  if (reason.status === 404 && isPreview) {
    return 'The Agensis backend returned 404 for the Nostr preview route. Start the current local backend or deploy it, then retry against the correct backend URL.';
  }
  if (reason.status === 502 && /^(?:Request failed|HTTP 502|Could not reach)/i.test(message)) {
    return 'The Nostr community could not be reached. Check the host and try again.';
  }
  return message;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(apiUrl(path), {
    ...init,
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...apiAuthHeaders(),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload?.error) {
    const detail = payload?.error?.message || payload?.error || `Request failed (${response.status})`;
    throw new NostrRequestError(String(detail), response.status, path);
  }
  return payload.data as T;
}

export function previewNostrInvite(inviteUrl: string) {
  return request<NostrInvitePreview>('/backend/nostr-communities/preview', {
    method: 'POST',
    body: JSON.stringify({ inviteUrl }),
  });
}

export function connectNostrCommunity(input: {
  workspaceId: string;
  inviteUrl: string;
  policyVersion?: string;
  ageConfirmed?: boolean;
  termsAccepted?: boolean;
  privacyAccepted?: boolean;
}) {
  return request<NostrConnectResult>(`/backend/workspaces/${encodeURIComponent(input.workspaceId)}/nostr-communities`, {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export function mapNostrChannels(connectionId: string, mappings: Array<{ channelId: string; sessionId: string }>) {
  return request<{ mapped: number }>(`/backend/nostr-communities/${encodeURIComponent(connectionId)}/channels`, {
    method: 'POST',
    body: JSON.stringify({ mappings }),
  });
}

export function listNostrCommunities(workspaceId: string, signal?: AbortSignal) {
  return request<NostrConnection[]>(
    `/backend/workspaces/${encodeURIComponent(workspaceId)}/nostr-communities`,
    { signal },
  );
}

export function getNostrChannels(connectionId: string, signal?: AbortSignal) {
  return request<NostrChannel[]>(`/backend/nostr-communities/${encodeURIComponent(connectionId)}/channels`, { signal });
}

export function setNostrChannelSubscription(connectionId: string, channelId: string, enabled: boolean) {
  return request<NostrChannelSubscription>(
    `/backend/nostr-communities/${encodeURIComponent(connectionId)}/channels/${encodeURIComponent(channelId)}`,
    { method: 'PATCH', body: JSON.stringify({ enabled }) },
  );
}

export function removeNostrChannel(connectionId: string, channelId: string) {
  return request<{ removed: boolean; channelId: string; sessionId: string }>(
    `/backend/nostr-communities/${encodeURIComponent(connectionId)}/channels/${encodeURIComponent(channelId)}`,
    { method: 'DELETE' },
  );
}

export function deleteNostrCommunity(connectionId: string) {
  return request<NostrConnection>(
    `/backend/nostr-communities/${encodeURIComponent(connectionId)}`,
    { method: 'DELETE' },
  );
}

export function getNostrMembers(sessionId: string, signal?: AbortSignal) {
  return request<NostrMember[]>(`/backend/sessions/${encodeURIComponent(sessionId)}/nostr-members`, { signal });
}

export function importableNostrChannels(channels: NostrChannel[]) {
  return channels.filter(channel => !channel.archived && channel.visibility === 'public');
}
