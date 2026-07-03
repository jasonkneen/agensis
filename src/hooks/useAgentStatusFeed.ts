import { useEffect, useMemo, useRef, useState } from 'react';
import type { WorkspacePresenceUser } from './useWorkspacePresence';
import type { Message, WorkspaceAgent } from '../types';
import { useTableSubscription, useRealtimeDeduper } from './useTableSubscription';
import { activityLine, extractActivityVerb, isActivityPlaceholderMessage } from '../lib/activityStatus';

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

const MAX_QUEUE = 8;

/** localStorage key for the persistent "hide the status feed" toggle. */
const MUTE_KEY = 'agensis_status_feed_muted';

function readMuted(): boolean {
  try {
    return localStorage.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

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
  /** Persistent "hide the whole feed" toggle — survives reload via localStorage. */
  muted: boolean;
  toggleMuted: () => void;
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
  const [muted, setMuted] = useState<boolean>(readMuted);
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
      setQueue(q => {
        // A "wrapped up" bookend is redundant noise if this agent already has
        // a queued entry — the activity/completion patch below already covers
        // it with a more useful line. Only keep it as a fallback for jobs that
        // finished with no activity heartbeat at all.
        const filtered = nextEvents.filter(
          ev => ev.kind !== 'done' || !q.some(item => item.agentId === ev.agentId),
        );
        if (!filtered.length) return q;
        return [...q, ...filtered].slice(-MAX_QUEUE);
      });
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
        // Search from the tail: an agent should only ever occupy the most
        // recent slot it was last written to, so if it somehow appears twice
        // we patch the newer one instead of resurrecting a stale older entry.
        let idx = -1;
        for (let i = q.length - 1; i >= 0; i -= 1) {
          if (q[i].agentId === agentId) { idx = i; break; }
        }
        if (placeholder) {
          const verb = extractActivityVerb(content);
          const text = activityLine(verb, content);
          if (idx === -1) {
            // A bare "Thinking…" heartbeat carries no detail and the daemon
            // re-posts it ~once/sec — don't let it pop a fresh bubble on its
            // own. Real activity verbs (reading/editing/searching…) and the
            // presence "started a job" bookend still create entries; thinking
            // only ever *patches* an entry that already exists.
            if (verb === 'thinking') return q;
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
          // Same status as last tick (typically the "Thinking…" heartbeat) —
          // bail without touching state so the bubble doesn't re-render or
          // replay its typewriter animation for no visible change.
          if (q[idx].text === text) return q;
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
  // no more relying on a manual click through a growing backlog. Keyed off the
  // *currently shown* entry's own id+text (not the whole queue array), so an
  // update that's still actively changing gets the full dwell time before we
  // move on — but an unrelated agent's activity queuing up behind it does NOT
  // reset this clock. Without that distinction the timer never fires in a busy
  // multi-agent workspace (it keeps getting re-armed by other agents' churn),
  // the backlog grows unbounded, and the bubble ends up showing stale info long
  // after it's out of date. Paused while the stack is expanded so a
  // click-to-read doesn't get yanked out from under the user.
  const front = queue[0];
  const frontKey = front ? `${front.id}:${front.text}` : '';
  const hasBacklog = queue.length > 1;
  useEffect(() => {
    if (expanded || !hasBacklog) return;
    const timer = window.setTimeout(() => setQueue(q => q.slice(1)), AUTO_ADVANCE_MS);
    return () => window.clearTimeout(timer);
  }, [frontKey, hasBacklog, expanded]);

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
    muted,
    toggleMuted: () =>
      setMuted(m => {
        const nextVal = !m;
        try {
          localStorage.setItem(MUTE_KEY, nextVal ? '1' : '0');
        } catch {
          /* private mode / storage disabled — stay in-memory for this session */
        }
        return nextVal;
      }),
    toggleExpanded: () => setExpanded(e => !e),
    next: () => setQueue(q => q.slice(1)),
    dismiss: () => setQueue(q => q.slice(1)),
    dismissOne: (id: string) => setQueue(q => q.filter(item => item.id !== id)),
    dismissAll: () => setQueue([]),
  };
}
