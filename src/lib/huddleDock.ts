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
 * What this browser is doing in the LiveKit room right now.
 *
 * Lives here rather than beside the room component so the dock's gating (is the
 * microphone actually open? should we be transcribing?) is testable without a
 * WebRTC session, an audio context or a browser.
 */
export interface HuddleLocalState {
  /** The WebRTC session is up. */
  connected: boolean;
  /** Our microphone is publishing — the gate on transcribing anything. */
  micEnabled: boolean;
  /** Display name of the participant currently speaking, or ''. */
  speaker: string;
  /** '' unless the session could not be established. */
  failed: string;
}

export const IDLE_HUDDLE_LOCAL: HuddleLocalState = {
  connected: false,
  micEnabled: false,
  speaker: '',
  failed: '',
};

/** Whether two local-state reports say the same thing. */
export function sameHuddleLocalState(a: HuddleLocalState, b: HuddleLocalState): boolean {
  return a.connected === b.connected
    && a.micEnabled === b.micEnabled
    && a.speaker === b.speaker
    && a.failed === b.failed;
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
