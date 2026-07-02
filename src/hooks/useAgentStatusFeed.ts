import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePresenceUser } from './useWorkspacePresence';
import type { WorkspaceAgent } from '../types';

/**
 * v1 data source for the sidebar agent status feed. We watch each agent's
 * presence `status` and emit a queued "update" on every transition — an agent
 * going busy reads as "started a job", going idle as "wrapped up". This is real,
 * already-flowing data (no new backend), and the queue is the notification-style
 * stack the human clicks through. Richer agent-posted status lines can push into
 * the same queue later without changing the component contract.
 */
export interface AgentStatusUpdate {
  id: string;
  agentId: string | null;
  handle: string | null;
  name: string;
  avatar: string | null;
  text: string;
  kind: 'start' | 'done' | 'info';
  ts: number;
}

const MAX_QUEUE = 20;

function statusToUpdate(
  prev: string | undefined,
  next: string,
): { text: string; kind: AgentStatusUpdate['kind'] } | null {
  if (prev === next) return null;
  if (next === 'busy') return { text: 'started a job…', kind: 'start' };
  // First time we see an agent already online/idle shouldn't spam — only emit
  // "done" when it was previously busy.
  if (prev === 'busy' && (next === 'online' || next === 'idle')) {
    return { text: 'wrapped up — idle', kind: 'done' };
  }
  return null;
}

export interface AgentStatusFeedState {
  current: AgentStatusUpdate | null;
  /** Updates newer/behind the current one still waiting to be seen. */
  pending: number;
  next: () => void;
  dismiss: () => void;
  dismissAll: () => void;
}

export function useAgentStatusFeed(
  presenceUsers: WorkspacePresenceUser[],
  agents: WorkspaceAgent[],
): AgentStatusFeedState {
  const [queue, setQueue] = useState<AgentStatusUpdate[]>([]);
  const prevStatus = useRef<Map<string, string>>(new Map());
  const seededRef = useRef(false);

  const avatarByKey = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      if (agent.id) map.set(`agent:${agent.id}`, agent.avatar);
      if (agent.handle) map.set(`handle:${agent.handle}`, agent.avatar);
    }
    return map;
  }, [agents]);

  useEffect(() => {
    const agentUsers = presenceUsers.filter(u => u.kind === 'agent');
    const nextEvents: AgentStatusUpdate[] = [];
    const seen = new Set<string>();

    for (const u of agentUsers) {
      const status = u.status || 'offline';
      seen.add(u.id);
      const prev = prevStatus.current.get(u.id);
      prevStatus.current.set(u.id, status);
      // On the very first pass we only record baseline status — we don't want a
      // burst of "started" updates for whatever happened to be busy at load.
      if (!seededRef.current) continue;
      const change = statusToUpdate(prev, status);
      if (!change) continue;
      const avatar =
        (u.agentId && avatarByKey.get(`agent:${u.agentId}`)) ||
        (u.handle && avatarByKey.get(`handle:${u.handle}`)) ||
        null;
      nextEvents.push({
        id: `${u.id}:${status}:${Date.now()}`,
        agentId: u.agentId ?? null,
        handle: u.handle ?? null,
        name: u.name,
        avatar,
        text: change.text,
        kind: change.kind,
        ts: Date.now(),
      });
    }

    // Forget agents that dropped out of presence so a later reconnect re-seeds
    // rather than emitting a phantom transition.
    for (const key of Array.from(prevStatus.current.keys())) {
      if (!seen.has(key)) prevStatus.current.delete(key);
    }

    seededRef.current = true;
    if (nextEvents.length) {
      setQueue(q => [...q, ...nextEvents].slice(-MAX_QUEUE));
    }
  }, [presenceUsers, avatarByKey]);

  return {
    current: queue[0] ?? null,
    pending: Math.max(0, queue.length - 1),
    next: () => setQueue(q => q.slice(1)),
    dismiss: () => setQueue(q => q.slice(1)),
    dismissAll: () => setQueue([]),
  };
}
