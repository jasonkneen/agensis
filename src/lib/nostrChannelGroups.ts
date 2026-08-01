import type { NostrConnection, NostrChannelSubscription } from './nostrCommunities';
import type { ChatSession } from '../types';

export interface NostrGroupedChannel {
  session: ChatSession;
  subscription: NostrChannelSubscription;
  enabled: boolean;
}

export interface NostrCommunityChannelGroup {
  connection: NostrConnection;
  channels: NostrGroupedChannel[];
}

/**
 * Splits mirrored channels away from ordinary Agensis channels while retaining
 * paused mappings and empty connections, so every connected community keeps a
 * durable settings re-entry point in the sidebar.
 */
export function splitNostrChannelGroups(
  sessions: ChatSession[],
  connections: NostrConnection[],
): { localSessions: ChatSession[]; communities: NostrCommunityChannelGroup[] } {
  const sessionsById = new Map(sessions.map(session => [session.id, session]));
  const mappedSessionIds = new Set<string>();
  const communities = connections.map(connection => {
    const channels = (connection.subscriptions || []).flatMap(subscription => {
      mappedSessionIds.add(subscription.sessionId);
      const session = sessionsById.get(subscription.sessionId);
      return session ? [{ session, subscription, enabled: subscription.enabled }] : [];
    });
    return { connection, channels };
  });
  return {
    localSessions: sessions.filter(session => !mappedSessionIds.has(session.id)),
    communities,
  };
}
