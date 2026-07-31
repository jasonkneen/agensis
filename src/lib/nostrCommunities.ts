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
}

export interface NostrChannel {
  id: string;
  name: string;
  description: string;
  type: string;
  visibility: 'public' | 'private';
  archived: boolean;
  joined: boolean;
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
    throw new Error(String(detail));
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

export function getNostrMembers(sessionId: string, signal?: AbortSignal) {
  return request<NostrMember[]>(`/backend/sessions/${encodeURIComponent(sessionId)}/nostr-members`, { signal });
}

export function importableNostrChannels(channels: NostrChannel[]) {
  return channels.filter(channel => !channel.archived && channel.visibility === 'public');
}
