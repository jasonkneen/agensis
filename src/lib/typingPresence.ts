// Typing presence: the emit policy and the expiry policy, with no React and no
// transport, so both can be tested without mounting anything.
//
// WHY THIS IS ITS OWN LANE AND NOT A FIELD ON THE PRESENCE SNAPSHOT
//
// `useItemPresence` already broadcasts a `presence_snapshot` every 2s while
// peers are around, and that payload carries every non-private window (18
// fields each) — roughly 1.5-2 KB with a normal desktop open. `setTyping` used
// to call `sendSnapshot()`, so wiring it to a composer's onChange would have
// put a ~2 KB frame on the wire per keystroke, fanned out to every socket in
// the workspace. At five characters a second in a five-person workspace that is
// ~50 KB/s from one person typing one sentence — several times the workspace's
// entire idle load, on the exact path plans/012-cut-idle-realtime-chatter.md
// was written to reduce.
//
// So typing rides a separate ~150-byte frame on the same channel, throttled to
// one send per TYPING_REARM_MS. tests/unit/typingPresence.test.ts and
// tests/unit/itemPresenceTyping.test.ts both fail if that regresses. If you are
// here to "unify the two paths", this is the reason not to.
//
// WHY THE FRAME CARRIES A RELATIVE ttlMs AND NEVER AN ABSOLUTE TIMESTAMP
//
// src/lib/activityStatus.ts had to buy a full 60s of slack (ACTIVITY_STALE_MS)
// purely to absorb the skew between a server clock that stamped a row and a
// browser clock that reads it. A 6s typing TTL has no room to budget for that.
// Sending a duration and computing `now + ttlMs` on ARRIVAL removes the entire
// skew class instead of paying for it — a sender five minutes behind still gets
// a correct 6 seconds of indicator.
//
// WHY THERE IS NO AGENT TYPING SIGNAL
//
// A human's "typing" is a 2-8 second prediction that something is about to
// arrive, and its whole value is that it is short. An agent's equivalent is a
// multi-minute tool run: a three-dot animation that runs for six minutes reads
// as a hang, not as activity. Agents already have the right surface and it
// carries a clock — activityChipLabel() -> "Thinking 1m 56s" — and that surface
// already learned the staleness lesson the expensive way (isLiveActivityPlaceholder
// exists because a placeholder went on claiming "Thinking 2m 11s" for hours
// after the agent had stopped). There is also a hard blocker: an agent-token
// socket has no `ws.userId`, so `authorizeRealtimeBroadcast` rejects it. Giving
// agents typing would mean opening a new authorization path for
// daemon-originated broadcasts to ship a worse version of something we have.

export type TypingScope = 'chat' | 'document';

/**
 * The wire frame. Deliberately flat and small — keep it under ~200 bytes
 * serialized; `itemPresenceTyping.test.ts` asserts the size.
 */
export interface TypingFrame {
  /** Frame version, so the next shape change can be additive. */
  v: 1;
  userId: string;
  name: string;
  color: string;
  scope: TypingScope;
  itemId: string;
  /**
   * RELATIVE milliseconds, never an absolute timestamp (see the header).
   * 0 means "stopped". The receiver clamps this to TYPING_TTL_MS, so a
   * malformed or hostile sender cannot pin an indicator open.
   */
  ttlMs: number;
}

/** How long a received frame keeps the indicator up, measured from arrival. */
export const TYPING_TTL_MS = 6000;

/**
 * Minimum gap between outbound frames for the same target. Strictly less than
 * TYPING_TTL_MS so a continuous typist never flickers between re-arms.
 */
export const TYPING_REARM_MS = 4000;

/**
 * Cap on concurrently-tracked typing targets per sender. A person types into
 * one composer; anything past a handful of simultaneous targets is a scripted
 * client using one socket as a fan-out multiplier.
 */
export const TYPING_MAX_TARGETS = 4;

export function typingKey(scope: TypingScope, itemId: string): string {
  return `${scope}:${itemId}`;
}

// ---------------------------------------------------------------------------
// Send side
// ---------------------------------------------------------------------------

/** Per-target timestamp of the last frame we put on the wire. */
export type TypingEmitState = Record<string, number>;

export interface TypingEmitDecision {
  emit: boolean;
  state: TypingEmitState;
}

/**
 * Should this `setTyping` call actually reach the wire?
 *
 * - starting/continuing: emit on the first call of a burst, then at most once
 *   per TYPING_REARM_MS while it continues.
 * - stopping: emit exactly one clear, and only if we ever announced this target.
 *   The clear is an optimisation — the receiver's TTL is what makes the
 *   indicator correct, so a dropped stop frame costs at most TYPING_TTL_MS of
 *   staleness and never a stuck indicator.
 *
 * Returns the same state reference when nothing changed, so callers can keep it
 * in a ref without churning.
 */
export function decideTypingEmit(
  state: TypingEmitState,
  scope: TypingScope,
  itemId: string,
  typing: boolean,
  now: number,
): TypingEmitDecision {
  if (!itemId) return { emit: false, state };
  const key = typingKey(scope, itemId);

  // Drop targets whose last announcement has already expired before applying
  // the cap, or one abandoned composer would hold a slot forever.
  const live: TypingEmitState = {};
  let pruned = false;
  for (const [existing, at] of Object.entries(state)) {
    if (now - at < TYPING_TTL_MS) live[existing] = at;
    else pruned = true;
  }

  if (!typing) {
    if (!(key in live)) return { emit: false, state: pruned ? live : state };
    delete live[key];
    return { emit: true, state: live };
  }

  const lastAt = live[key];
  if (lastAt !== undefined && now - lastAt < TYPING_REARM_MS) {
    return { emit: false, state: pruned ? live : state };
  }
  if (lastAt === undefined && Object.keys(live).length >= TYPING_MAX_TARGETS) {
    return { emit: false, state: pruned ? live : state };
  }

  live[key] = now;
  return { emit: true, state: live };
}

/**
 * May this composer announce typing at all?
 *
 * A rule rather than an inline boolean because one of its clauses is
 * security-shaped and easy to delete by accident: `item-presence:<workspaceId>`
 * fans out to every member with `read` on the workspace, and a typing frame
 * carries an `itemId`. Emitting for a direct message would tell the whole
 * workspace that a private session exists and is active right now. The sidebar
 * only draws presence for sessions it already lists, but that is a UI
 * convenience and NOT an authorization boundary — do not lean on it.
 *
 * The structural fix is per-item channel names, which is blocked:
 * `workspaceIdFromRealtimeChannel` (server/realtime.cjs) rejects any channel
 * with a second colon, and that grammar is shared by canvas, cursors,
 * item-presence, agent-presence and agent-status. Until that widens, DMs stay
 * off this lane.
 */
export function shouldAnnounceTyping(input: {
  hasSink: boolean;
  isDirectMessage: boolean;
  readOnly: boolean;
}): boolean {
  if (!input.hasSink) return false;
  if (input.isDirectMessage) return false;
  if (input.readOnly) return false;
  return true;
}

export function buildTypingFrame(input: {
  userId: string;
  name: string;
  color: string;
  scope: TypingScope;
  itemId: string;
  typing: boolean;
}): TypingFrame {
  return {
    v: 1,
    userId: input.userId,
    name: input.name,
    color: input.color,
    scope: input.scope,
    itemId: input.itemId,
    ttlMs: input.typing ? TYPING_TTL_MS : 0,
  };
}

// ---------------------------------------------------------------------------
// Receive side
// ---------------------------------------------------------------------------

export interface TypingPeer {
  userId: string;
  name: string;
  color: string;
  /** Absolute local-clock deadline, computed on arrival. */
  expiresAt: number;
}

/** `${scope}:${itemId}` -> userId -> peer */
export type TypingState = Record<string, Record<string, TypingPeer>>;

export const EMPTY_TYPING_STATE: TypingState = {};

function isTypingScope(value: unknown): value is TypingScope {
  return value === 'chat' || value === 'document';
}

/**
 * Fold one received frame into receiver state. Returns the SAME reference when
 * nothing changed — `useItemPresence` lives at the App root, so a new object
 * per inbound frame would re-render the window tree for no reason.
 *
 * Frames from `localUserId` are ignored: the broadcast relay does not exclude
 * the sender, so every client hears its own frames back.
 */
export function applyTypingFrame(
  state: TypingState,
  frame: unknown,
  localUserId: string,
  now: number,
): TypingState {
  if (!frame || typeof frame !== 'object') return state;
  const candidate = frame as Partial<TypingFrame>;
  if (candidate.v !== 1) return state;
  if (typeof candidate.userId !== 'string' || !candidate.userId) return state;
  if (candidate.userId === localUserId) return state;
  if (typeof candidate.itemId !== 'string' || !candidate.itemId) return state;
  if (!isTypingScope(candidate.scope)) return state;
  if (typeof candidate.ttlMs !== 'number' || !Number.isFinite(candidate.ttlMs)) return state;

  const key = typingKey(candidate.scope, candidate.itemId);
  const bucket = state[key];

  if (candidate.ttlMs <= 0) {
    if (!bucket || !bucket[candidate.userId]) return state;
    const nextBucket = { ...bucket };
    delete nextBucket[candidate.userId];
    const next = { ...state };
    if (Object.keys(nextBucket).length === 0) delete next[key];
    else next[key] = nextBucket;
    return next;
  }

  // Clamped, so the ceiling on how long an indicator can live is ours and not
  // the sender's. This is the whole staleness guarantee in one line.
  const expiresAt = now + Math.min(candidate.ttlMs, TYPING_TTL_MS);
  return {
    ...state,
    [key]: {
      ...(bucket || {}),
      [candidate.userId]: {
        userId: candidate.userId,
        name: typeof candidate.name === 'string' && candidate.name ? candidate.name : 'Someone',
        color: typeof candidate.color === 'string' && candidate.color ? candidate.color : '#3b82f6',
        expiresAt,
      },
    },
  };
}

/**
 * Drop everything whose deadline has passed. This — not a stop frame — is what
 * answers "what does the UI show when the signal simply stops": the indicator
 * clears itself within TYPING_TTL_MS of the last frame, whether the sender
 * stopped politely, closed the tab, lost the socket, or was force-quit.
 *
 * Same-reference-when-unchanged, for the same re-render reason as above.
 */
export function pruneExpiredTyping(state: TypingState, now: number): TypingState {
  let changed = false;
  const next: TypingState = {};
  for (const [key, bucket] of Object.entries(state)) {
    const keptBucket: Record<string, TypingPeer> = {};
    for (const [userId, peer] of Object.entries(bucket)) {
      if (peer.expiresAt > now) keptBucket[userId] = peer;
      else changed = true;
    }
    if (Object.keys(keptBucket).length > 0) next[key] = keptBucket;
  }
  return changed ? next : state;
}

export function typingPeersFor(
  state: TypingState,
  scope: TypingScope,
  itemId: string,
  now: number,
): TypingPeer[] {
  const bucket = state[typingKey(scope, itemId)];
  if (!bucket) return [];
  return Object.values(bucket).filter(peer => peer.expiresAt > now);
}

// ---------------------------------------------------------------------------
// View merge
// ---------------------------------------------------------------------------

/** The shape `useItemPresence` hands to the sidebar (types/index.ts ItemPresenceUser). */
export interface TypingPresenceUser {
  userId: string;
  name: string;
  color: string;
  typing?: boolean;
}

/**
 * Overlay live typing onto the presence map the sidebar already renders.
 *
 * A peer who is typing but has no presence row for this item is ADDED, not
 * skipped: presence is derived from open floating windows, so a peer typing
 * into a window we have not yet received a snapshot for would otherwise be
 * invisible. A typing frame is itself proof of presence, and it carries a
 * tighter TTL (6s) than the snapshot lane's stale cutoff (7s).
 */
export function mergeTypingIntoPresence<T extends TypingPresenceUser>(
  presence: Record<string, T[]>,
  typing: TypingState,
  scope: TypingScope,
  now: number,
): Record<string, T[]> {
  const keys = Object.keys(typing);
  if (keys.length === 0) return presence;

  let changed = false;
  const next: Record<string, T[]> = { ...presence };

  for (const key of keys) {
    const [frameScope, ...idParts] = key.split(':');
    if (frameScope !== scope) continue;
    const itemId = idParts.join(':');
    if (!itemId) continue;
    const peers = Object.values(typing[key]).filter(peer => peer.expiresAt > now);
    if (peers.length === 0) continue;

    const existing = next[itemId] || [];
    const byId = new Map(peers.map(peer => [peer.userId, peer]));
    const merged = existing.map(user => (
      byId.has(user.userId) ? { ...user, typing: true } : user
    ));
    const seen = new Set(existing.map(user => user.userId));
    for (const peer of peers) {
      if (seen.has(peer.userId)) continue;
      merged.push({
        userId: peer.userId,
        name: peer.name,
        color: peer.color,
        typing: true,
      } as unknown as T);
    }
    next[itemId] = merged;
    changed = true;
  }

  return changed ? next : presence;
}
