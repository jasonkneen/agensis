import type { ActivityEventType } from '../types';
import { activityMetadata } from './activityEntry';

/**
 * The family a given `activity_events` row belongs to, mapped from its
 * `event_type`. The family is the shared identity underlying the Activity
 * window's filter tabs, the coloured family tag on each row, and the timeline
 * dot/segment — so the mapping and every derived colour live here, not split
 * across the component and the stylesheet.
 *
 * Pure type/string work; no React, no DOM.
 */

export type ActivityFilter =
  | 'all' | 'docs' | 'tasks' | 'messages' | 'comments' | 'agents' | 'memory' | 'people' | 'canvas';

export const ACTIVITY_FAMILY: Record<ActivityEventType, Exclude<ActivityFilter, 'all'>> = {
  document_created: 'docs',
  document_updated: 'docs',
  document_deleted: 'docs',
  task_created: 'tasks',
  task_completed: 'tasks',
  task_updated: 'tasks',
  comment_created: 'comments',
  chat_created: 'messages',
  message_sent: 'messages',
  memory_added: 'memory',
  member_joined: 'people',
  canvas_updated: 'canvas',
  agent_connected: 'agents',
  agent_disconnected: 'agents',
  // A credentialed provider call an agent made through the server. Filed under
  // Agents because that is what the reader is auditing — which agent spent a
  // provider credential, on what, and what came back.
  provider_call: 'agents',
  // Filed under People for both lanes. The reader auditing a join link is asking
  // "who got into this workspace, and how" — the answer belongs beside
  // member_joined whether the joiner was a person or an agent.
  join_link_created: 'people',
  join_link_redeemed: 'people',
};

/**
 * The family a given event belongs to, or 'all' when its event_type is
 * unmapped. Used by the filter tabs, the family tag and the timeline dot.
 */
export function activityFamilyFor(
  event: Pick<{ event_type: ActivityEventType }, 'event_type'>,
): Exclude<ActivityFilter, 'all'> | 'all' {
  return ACTIVITY_FAMILY[event.event_type] ?? 'all';
}

// Family -> CSS tag class (see the .activity-family-* block in index.css). A
// solid-block family tag on each row is the trajectory screen's visual grammar:
// a scan of the feed should land on the kind of work, not the clock next to it.
export function familyTagClass(
  family: Exclude<ActivityFilter, 'all'> | 'all' | undefined,
): string {
  switch (family) {
    case 'docs': return 'activity-family-docs';
    case 'tasks': return 'activity-family-tasks';
    case 'messages': return 'activity-family-messages';
    case 'comments': return 'activity-family-comments';
    case 'agents': return 'activity-family-agents';
    case 'memory': return 'activity-family-memory';
    case 'people': return 'activity-family-people';
    case 'canvas': return 'activity-family-canvas';
    default: return 'activity-family-all';
  }
}

/**
 * THE single source of truth for a family's accent hue, as a CSS var reference.
 *
 * This is the value both the `.activity-family-*` tag in index.css and the
 * timeline dot/segment resolve to. The tag decorates it (a `color-mix(...)`
 * background + border at the SAME base token); the dot paints it raw as a
 * background. Because both read this map, a family's accent can never drift
 * between the two — the divergence this map replaced had the dot hardcoding a
 * second set of oklch literals that disagreed with the tag hues.
 *
 * `docs` and `all` are deliberately token-var (--primary / --foreground) rather
 * than a bespoke hue, so they follow the active accent/foreground.
 */
export const ACTIVITY_SOURCE_OF_TRUTH: Record<ActivityFilter, string> = {
  all: 'var(--foreground)',
  docs: 'var(--primary)',
  tasks: 'var(--agensis-family-tasks)',
  messages: 'var(--agensis-family-messages)',
  comments: 'var(--agensis-family-comments)',
  agents: 'var(--agensis-family-agents)',
  memory: 'var(--agensis-family-memory)',
  people: 'var(--agensis-family-people)',
  canvas: 'var(--agensis-family-canvas)',
};

// Background hue used for the timeline segment + dot so the strip and the tag
// share one colour identity per family. Reads from ACTIVITY_SOURCE_OF_TRUTH.
export function familyDotColor(
  family: Exclude<ActivityFilter, 'all'> | 'all' | undefined,
): string {
  return ACTIVITY_SOURCE_OF_TRUTH[family ?? 'all'];
}

/** Who caused an event: a person, or an agent acting on its own. */
export type ActivityActor = 'person' | 'agent';
export type ActivityActorFilter = 'anyone' | ActivityActor;

/**
 * The actor recorded on the event (`metadata.actor_kind`, written by the browser for what a
 * person does and by the server for what an agent does through MCP). Older rows carry none:
 * those fall back to the family, so agent connections read as agents and everything else as a
 * person.
 */
export function activityActor(
  event: { event_type: ActivityEventType; metadata?: unknown },
): ActivityActor {
  const kind = activityMetadata(event.metadata)?.actor_kind;
  if (kind === 'agent' || kind === 'person') return kind;
  return ACTIVITY_FAMILY[event.event_type] === 'agents' ? 'agent' : 'person';
}
