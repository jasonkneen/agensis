import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePresenceUser } from './useWorkspacePresence';
import type { Message, WorkspaceAgent } from '../types';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { extractActivityVerb, isActivityPlaceholderMessage } from '../lib/activityStatus';

/**
 * Data source for the sidebar agent status feed. Two layers feed the same
 * queue:
 *  1. Presence `status` transitions (busy/idle) — coarse "started a job" /
 *     "wrapped up" bookends, always available even for agents that never post
 *     an activity line.
 *  2. A workspace-wide `messages` subscription that watches for the same
 *     activity-placeholder rows chat windows already parse (see
 *     `lib/activityStatus`) — "thinking", "reading src/App.tsx", "searching",
 *     etc. — so the bubble reflects what the agent is actually doing, not just
 *     two canned strings, and updates live in place while that agent is the
 *     one currently shown.
 */
export interface AgentStatusUpdate {
  id: string;
  agentId: string | null;
  handle: string | null;
  name: string;
  avatar: string | null;
  text: string;
  kind: 'start' | 'done' | 'info' | 'activity';
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

/** "reading" -> "Reading…" for a short, human status line. */
function activityLine(verb: string, content: string): string {
  const capitalized = verb.charAt(0).toUpperCase() + verb.slice(1);
  const rest = content.trim().slice(verb.length).trim();
  return rest ? `${capitalized} ${rest}…` : `${capitalized}…`;
}

/** First line of the agent's real (non-placeholder) reply, trimmed for the bubble. */
function completionLine(content: string): string {
  const firstLine = content.trim().split('\n')[0] || '';
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine || 'wrapped up';
}

/** How long a queued update stays on screen before auto-advancing to the next one. */
const AUTO_ADVANCE_MS = 4500;

export interface AgentStatusFeedState {
  current: AgentStatusUpdate | null;
  /** Full backlog (current first) for stack rendering when expanded. */
  queue: AgentStatusUpdate[];
  /** Updates newer/behind the current one still waiting to be seen. */
  pending: number;
  /** Whether the sidebar has expanded the stack into an individually-dismissable list. */
  expanded: boolean;
  toggleExpanded: () => void;
  next: () => void;
  dismiss: () => void;
  /** Dismiss one specific update out of the stack (used by the expanded list). */
  dismissOne: (id: string) => void;
  dismissAll: () => void;
}

export function useAgentStatusFeed(
  presenceUsers: WorkspacePresenceUser[],
  agents: WorkspaceAgent[],
  workspaceId?: string | null,
): AgentStatusFeedState {
  const [queue, setQueue] = useState<AgentStatusUpdate[]>([]);
  const [expanded, setExpanded] = useState(false);
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

  const agentById = useMemo(() => {
    const map = new Map<string, WorkspaceAgent>();
    for (const agent of agents) if (agent.id) map.set(agent.id, agent);
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

  // Live activity text: watch agent-authored messages workspace-wide (same
  // activity-placeholder rows chat windows already render) and patch whichever
  // queue entry belongs to that agent in place, so the bubble tracks the
  // agent's actual progress (thinking → reading → editing → done) instead of
  // sitting on the two generic presence strings above for the whole job.
  const deduper = useRealtimeDeduper();
  useTableSubscription<Message>(
    {
      enabled: !!workspaceId,
      channelName: `messages:workspace:${workspaceId}:agent-activity`,
      table: 'messages',
      event: '*',
      schema: 'public',
      filter: `workspace_id=eq.${workspaceId}`,
    },
    (payload) => {
      if (!deduper.shouldProcess(payload)) return;
      const row = payload.new;
      if (!row || row.sender_kind !== 'agent' || !row.sender_id) return;
      const agentId = row.sender_id;
      const content = typeof row.content === 'string' ? row.content : '';
      const placeholder = isActivityPlaceholderMessage(row);
      setQueue(q => {
        const idx = q.findIndex(item => item.agentId === agentId);
        if (placeholder) {
          const verb = extractActivityVerb(content);
          const text = activityLine(verb, content);
          if (idx === -1) {
            const agent = agentById.get(agentId);
            const avatar = avatarByKey.get(`agent:${agentId}`) || null;
            const entry: AgentStatusUpdate = {
              id: `${agentId}:${row.id}`,
              agentId,
              handle: agent?.handle ?? null,
              name: agent?.name || row.sender_name || 'Agent',
              avatar,
              text,
              kind: 'activity',
              ts: Date.now(),
            };
            return [...q, entry].slice(-MAX_QUEUE);
          }
          const next = [...q];
          next[idx] = { ...next[idx], text, kind: 'activity', ts: Date.now() };
          return next;
        }
        // Real content replacing (or following) a placeholder — refine that
        // agent's entry into a completion line instead of leaving it on the
        // last activity verb. If there's no entry yet (e.g. a very fast job),
        // there's nothing to refine — presence's "wrapped up" bookend covers it.
        if (idx === -1) return q;
        const next = [...q];
        next[idx] = { ...next[idx], text: completionLine(content), kind: 'done', ts: Date.now() };
        return next;
      });
    },
  );

  // Auto-advance so the bubble catches up to the latest activity on its own —
  // no more relying on a manual click through a growing backlog. Re-armed on
  // every queue change, including in-place activity patches, so an update
  // that's still actively changing gets the full dwell time before we move on.
  // Paused while the stack is expanded so a click-to-read doesn't get yanked
  // out from under the user.
  useEffect(() => {
    if (expanded || queue.length <= 1) return;
    const timer = window.setTimeout(() => setQueue(q => q.slice(1)), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [queue, expanded]);

  // Collapse back to the compact bubble once the backlog empties out from
  // under an expanded view (e.g. dismissed one-by-one down to nothing).
  useEffect(() => {
    if (queue.length === 0) setExpanded(false);
  }, [queue.length]);

  return {
    current: queue[0] ?? null,
    queue,
    pending: Math.max(0, queue.length - 1),
    expanded,
    toggleExpanded: () => setExpanded(e => !e),
    next: () => setQueue(q => q.slice(1)),
    dismiss: () => setQueue(q => q.slice(1)),
    dismissOne: (id: string) => setQueue(q => q.filter(item => item.id !== id)),
    dismissAll: () => setQueue([]),
  };
}
