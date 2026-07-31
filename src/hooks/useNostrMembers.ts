import { useEffect, useState } from 'react';
import { getNostrMembers, type NostrMember } from '@/lib/nostrCommunities';

/** Remote Nostr identities addressable from one mirrored Agensis channel. */
export function useNostrMembers(sessionId?: string | null) {
  const [members, setMembers] = useState<NostrMember[]>([]);

  useEffect(() => {
    if (!sessionId) {
      setMembers([]);
      return;
    }
    const controller = new AbortController();
    getNostrMembers(sessionId, controller.signal)
      .then(setMembers)
      .catch(() => {
        if (!controller.signal.aborted) setMembers([]);
      });
    return () => controller.abort();
  }, [sessionId]);

  return members;
}
