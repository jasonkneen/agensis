// ---------------------------------------------------------------------------
// The huddle dock's decisions, kept out of the component so they can be tested
// without a LiveKit connection, an audio context or a browser.
// ---------------------------------------------------------------------------

/** The panel's tabs. Chat is first because it is what a call is mostly used for. */
export const HUDDLE_DOCK_TABS = ['chat', 'transcript', 'notes'] as const;
export type HuddleDockTab = (typeof HUDDLE_DOCK_TABS)[number];
export const DEFAULT_HUDDLE_DOCK_TAB: HuddleDockTab = 'chat';

export function normalizeHuddleDockTab(value: unknown): HuddleDockTab {
  const tab = String(value == null ? '' : value).trim().toLowerCase();
  return (HUDDLE_DOCK_TABS as readonly string[]).includes(tab)
    ? (tab as HuddleDockTab)
    : DEFAULT_HUDDLE_DOCK_TAB;
}

/**
 * Client-side mirror of NOTES_MAX_LENGTH in server/huddles.cjs. Only used to
 * stop typing past the point the server would reject — the server's value is
 * still the actual limit enforced.
 */
export const HUDDLE_NOTES_MAX_LENGTH = 20_000;

/**
 * What this browser is doing in the LiveKit room right now.
 *
 * Lives here rather than beside the room component so the dock's gating (is the
 * microphone actually open? should we be transcribing?) is testable without a
 * WebRTC session, an audio context or a browser.
 */
/**
 * One participant as LiveKit reports them.
 *
 * Agents are in this list because they are genuinely in the room — the voice
 * worker joins, publishes audio and a held video tile, and stamps
 * `agensis.*` attributes so a participant can be matched back to the agent it
 * is. Before that, agents had no LiveKit presence at all and the chips had to be
 * synthesised from a separate roster that no presence event ever mentioned.
 */
export interface HuddleRoomParticipant {
  identity: string;
  name: string;
  isLocal: boolean;
  isSpeaking: boolean;
  kind: 'human' | 'agent';
  /** Set only for agents, from the `agensis.agentId` attribute. */
  agentId: string;
  handle: string;
  accentColor: string;
  /** The agent's held image / a human's camera is publishing. */
  hasVideo: boolean;
}

export interface HuddleLocalState {
  /** The WebRTC session is up. */
  connected: boolean;
  /** Our microphone is publishing — the gate on transcribing anything. */
  micEnabled: boolean;
  /** Display name of the participant currently speaking, or ''. */
  speaker: string;
  /** '' unless the session could not be established. */
  failed: string;
  /** Everyone in the room, humans and agents alike, straight from LiveKit. */
  roomParticipants: HuddleRoomParticipant[];
}

/** Read the agensis identity a voice worker stamps on itself. */
export function roomParticipantFrom(participant: {
  identity: string;
  name?: string;
  isLocal?: boolean;
  isSpeaking?: boolean;
  attributes?: Record<string, string>;
  videoTrackPublications?: { size: number };
}): HuddleRoomParticipant {
  const attributes = participant.attributes || {};
  const isAgent = attributes['agensis.kind'] === 'agent';
  return {
    identity: participant.identity,
    name: attributes['agensis.name'] || participant.name || participant.identity,
    isLocal: Boolean(participant.isLocal),
    isSpeaking: Boolean(participant.isSpeaking),
    kind: isAgent ? 'agent' : 'human',
    agentId: attributes['agensis.agentId'] || '',
    handle: attributes['agensis.handle'] || '',
    accentColor: attributes['agensis.accentColor'] || '',
    hasVideo: Number(participant.videoTrackPublications?.size || 0) > 0,
  };
}

/**
 * The participant chips, built from the room itself.
 *
 * This replaces merging a LiveKit human list with a separately-maintained agent
 * roster: with agents in the room there is one source of truth, so a chip cannot
 * show an agent that is not actually connected — which is what "the agent is in
 * the call" has to mean.
 */
export function buildRoomDockParticipants(
  participants: readonly HuddleRoomParticipant[],
  activeAgentId = '',
): HuddleDockParticipant[] {
  const out: HuddleDockParticipant[] = [];
  const seen = new Set<string>();
  for (const participant of participants) {
    const id = participant.kind === 'agent' && participant.agentId
      ? participant.agentId
      : participant.identity;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: participant.isLocal ? 'You' : (participant.name || (participant.kind === 'agent' ? 'Agent' : 'Someone')),
      kind: participant.kind,
      ...(participant.kind === 'agent'
        ? { active: Boolean(activeAgentId) && participant.agentId === activeAgentId }
        : {}),
      speaking: participant.isSpeaking,
    } as HuddleDockParticipant);
  }
  return out;
}

export const IDLE_HUDDLE_LOCAL: HuddleLocalState = {
  connected: false,
  micEnabled: false,
  speaker: '',
  failed: '',
  roomParticipants: [],
};

/** Whether two local-state reports say the same thing. */
export function sameHuddleLocalState(a: HuddleLocalState, b: HuddleLocalState): boolean {
  return a.connected === b.connected
    && a.micEnabled === b.micEnabled
    && a.speaker === b.speaker
    && a.failed === b.failed
    && sameRoomParticipants(a.roomParticipants, b.roomParticipants);
}

/**
 * Roster equality, by the fields the UI actually renders.
 *
 * LiveKit re-emits participants on every track and speaking change, so comparing
 * object identity here would report a change on every frame and re-render the
 * whole dock while someone is simply talking.
 */
export function sameRoomParticipants(
  a: readonly HuddleRoomParticipant[] = [],
  b: readonly HuddleRoomParticipant[] = [],
): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (x.identity !== y.identity
      || x.name !== y.name
      || x.isSpeaking !== y.isSpeaking
      || x.kind !== y.kind
      || x.agentId !== y.agentId
      || x.hasVideo !== y.hasVideo) return false;
  }
  return true;
}

export interface HuddleDockVisibilityInput {
  /** A target has been chosen — the user asked for this huddle. */
  hasTarget: boolean;
  /** This browser holds a live connection. */
  connected: boolean;
  /** The huddle row says a call is running (someone is in it, maybe not us). */
  live: boolean;
  /** A transport/permission error worth keeping on screen. */
  hasError: boolean;
  /** Reading one specific huddle, usually an ended one, rather than being in a call. */
  record?: boolean;
}

/**
 * Whether the dock renders at all.
 *
 * Deliberately NOT "connected" alone. Four states have to keep the panel up:
 * connecting (a target exists but the socket is not up yet — hiding here makes
 * the button look broken for a second), a call still running that we have left
 * the audio of, an error, which is the one moment the user most needs something
 * on screen to read, and a RECORD — an ended huddle someone asked to read,
 * which by definition is neither live nor connected and would otherwise open a
 * panel that immediately vanished.
 */
export function shouldShowHuddleDock(input: HuddleDockVisibilityInput): boolean {
  if (!input.hasTarget) return false;
  return !!input.record || input.connected || input.live || input.hasError;
}

/**
 * Participants shown as chips in the header.
 *
 * Humans come from presence events; agents come from the session roster,
 * because an agent is in the call in every way that matters (it hears the
 * transcript and speaks) but never holds a LiveKit connection, so no presence
 * event will ever mention it. Dropping them would make a call with three agents
 * look empty.
 */
export interface HuddleDockParticipant {
  id: string;
  name: string;
  kind: 'human' | 'agent';
  /** Agents that are the current speaking target get marked. */
  active?: boolean;
  speaking?: boolean;
}

export function buildDockParticipants({
  humans,
  agents,
  activeAgentId,
  speakingName,
}: {
  humans: readonly { identity: string; name: string }[];
  agents: readonly { id: string; name: string }[];
  activeAgentId?: string;
  speakingName?: string;
}): HuddleDockParticipant[] {
  const out: HuddleDockParticipant[] = [];
  const seen = new Set<string>();
  for (const human of humans) {
    const id = String(human.identity || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: human.name || 'Someone', kind: 'human' });
  }
  for (const agent of agents) {
    const id = String(agent.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name: agent.name || 'Agent',
      kind: 'agent',
      active: !!activeAgentId && agent.id === activeAgentId,
      speaking: !!speakingName && agent.name === speakingName,
    });
  }
  return out;
}

/** Two-letter initials for a chip. Never an emoji — this repo's rule. */
export function participantInitials(name: string): string {
  const cleaned = String(name || '').trim();
  if (!cleaned) return '??';
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return cleaned.slice(0, 2).toUpperCase();
}
