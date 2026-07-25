import type { Huddle, HuddleEvent, HuddleParticipant, HuddleState } from '../types';

// Client-side mirror of foldHuddleState in server/huddles.cjs. The server folds
// on every GET; this folds the SAME append-only log locally so a realtime event
// updates the card without a round-trip.
//
// Why fold instead of storing a participant list:
//   - a redelivered participant_joined is an idempotent Map.set,
//   - a redelivered participant_left is an idempotent Map.delete,
//   - a late event still lands in the right place because we sort by the
//     event's OWN timestamp, not by arrival order.
// That is the whole reason the card survives a websocket reconnect (which
// replays state) with no reconciliation pass.
//
// Deliberately NOT `Math.max(1, present.size)`. An ended huddle has zero
// participants and says so; "how many were here" is answered by
// peakParticipants / everJoinedCount, which are facts derived from the log.
// A floor of 1 is how an ended huddle ends up claiming "1 participant" forever.

function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function compareEvents(a: HuddleEvent, b: HuddleEvent): number {
  const ta = timeOf(a.created_at);
  const tb = timeOf(b.created_at);
  if (ta !== tb) return ta - tb;
  return Number(a.seq ?? 0) - Number(b.seq ?? 0);
}

function userIdFromIdentity(identity: string): string {
  return identity.startsWith('user:') ? identity.slice(5) : '';
}

export function foldHuddleState(huddle: Huddle | null, events: HuddleEvent[] = []): HuddleState | null {
  if (!huddle) return null;
  const rows = [...events].sort(compareEvents);
  const present = new Map<string, HuddleParticipant>();
  const everJoined = new Set<string>();
  let peakParticipants = 0;
  let endedAt: string | null = huddle.ended_at ?? null;

  for (const event of rows) {
    const identity = event.identity || '';
    if (event.kind === 'participant_joined' && identity) {
      everJoined.add(identity);
      present.set(identity, {
        identity,
        userId: userIdFromIdentity(identity),
        name: event.display_name || identity,
        joinedAt: event.created_at ?? null,
      });
      if (present.size > peakParticipants) peakParticipants = present.size;
    } else if (event.kind === 'participant_left' && identity) {
      present.delete(identity);
    } else if (event.kind === 'ended') {
      present.clear();
      if (!endedAt) endedAt = event.created_at ?? null;
    }
  }

  const active = !endedAt;
  const participants = active
    ? [...present.values()].sort((a, b) => timeOf(a.joinedAt) - timeOf(b.joinedAt))
    : [];

  return {
    id: huddle.id,
    workspaceId: huddle.workspace_id,
    sessionId: huddle.session_id,
    roomName: huddle.room_name,
    startedBy: huddle.started_by ?? null,
    startedAt: huddle.started_at ?? null,
    endedAt,
    active,
    participants,
    participantCount: participants.length,
    peakParticipants,
    everJoinedCount: everJoined.size,
  };
}

/** "Ada, Sam and 2 others" — the card's one-line roster. */
export function participantSummary(participants: HuddleParticipant[]): string {
  const names = participants.map(p => p.name).filter(Boolean);
  if (names.length === 0) return '';
  if (names.length === 1) return names[0];
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  const rest = names.length - 2;
  return `${names[0]}, ${names[1]} and ${rest} other${rest === 1 ? '' : 's'}`;
}

/** Elapsed call time as m:ss / h:mm:ss. */
export function huddleDuration(state: HuddleState, nowMs: number): string {
  const start = timeOf(state.startedAt);
  if (!start) return '';
  const end = state.endedAt ? timeOf(state.endedAt) : nowMs;
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${minutes}:${pad(secs)}`;
}
