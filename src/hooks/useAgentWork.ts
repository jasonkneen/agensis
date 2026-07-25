import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { backendClient } from '../lib/backendClient';
import { useTableSubscription } from './useTableSubscription';
import {
  applyAgentJobRow,
  clearAgentWork,
  getSessionWork,
  getThreadWork,
  resetAgentWork,
  subscribeToAgentWork,
  type AgentWork,
} from '../lib/agentWork';
import type { AgentJobRow } from '../types';

// NEVER '*': the row also carries `prompt` (the entire daemon prompt, i.e. the
// whole conversation context + system prompt) and `response` (the entire reply).
// The badge needs a session, a status and a start time.
const JOB_COLUMNS = 'id, session_id, agent_id, status, started_at, created_at, metadata';

/**
 * Keep {@link agentWork} fed for a workspace: one seed fetch of the jobs already
 * running, then the `agent_jobs` realtime stream.
 *
 * Mount this ONCE per app (the sidebar does it — it is always mounted, even
 * behind the mobile drawer). Everything else just reads the store.
 *
 * `agent_jobs` only broadcasts on job start, claim and finish — the per-second
 * "Thinking Ns" progress deltas update the row WITHOUT notifying subscribers
 * (see the `update agent_jobs` sites in server/index.cjs), so this is a handful
 * of frames per turn, not the message firehose NET-07 had to undo.
 */
export function useAgentWorkFeed(workspaceId: string | null | undefined): void {
  const key = typeof workspaceId === 'string' ? workspaceId.trim() : '';

  useEffect(() => {
    if (!key) {
      clearAgentWork();
      return;
    }
    let cancelled = false;
    const fetchStartedAt = Date.now();
    clearAgentWork();
    void backendClient
      .from<AgentJobRow[]>('agent_jobs')
      .select(JOB_COLUMNS)
      .eq('workspace_id', key)
      .eq('status', 'running')
      .then(({ data }) => {
        if (cancelled) return;
        // Rows that arrived over realtime while this was in flight win — see
        // resetAgentWork's keepAppliedSince.
        resetAgentWork(Array.isArray(data) ? data : [], fetchStartedAt);
      });
    return () => {
      cancelled = true;
      clearAgentWork();
    };
  }, [key]);

  useTableSubscription<AgentJobRow>(
    {
      enabled: !!key,
      channelName: `agent_jobs:${key}`,
      table: 'agent_jobs',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${key}`,
    },
    (payload) => {
      const eventType = payload.eventType || 'UPDATE';
      applyAgentJobRow(eventType === 'DELETE' ? payload.old : payload.new, eventType);
    },
  );
}

/**
 * Is an agent working in this session right now, and since when?
 *
 * Re-renders the caller only when THIS session's entry changes — never on the
 * badge's clock tick, and not when some other session's job starts (the store's
 * snapshots are reference-stable, so React bails out).
 */
export function useSessionWork(sessionId: string | null | undefined): AgentWork | null {
  const snapshot = useCallback(() => getSessionWork(sessionId), [sessionId]);
  return useSyncExternalStore(subscribeToAgentWork, snapshot, snapshot);
}

/** Same, for one thread — keyed by the parent message id. */
export function useThreadWork(parentMessageId: string | null | undefined): AgentWork | null {
  const snapshot = useCallback(() => getThreadWork(parentMessageId), [parentMessageId]);
  return useSyncExternalStore(subscribeToAgentWork, snapshot, snapshot);
}
