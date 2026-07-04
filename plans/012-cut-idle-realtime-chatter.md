# Plan 012: Cut idle realtime chatter — cursors, presence heartbeat, stale-prune re-renders

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 871b535..HEAD -- src/hooks/useMultiplayerCursors.ts src/hooks/useItemPresence.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `871b535`, 2026-07-04

## Why this matters

Even a **solo, idle** user pays a constant realtime tax today:

1. Every mouse move broadcasts a cursor frame over the WebSocket up to ~31×/sec
   (32ms throttle) even when nobody else is in the workspace to see it.
2. `useItemPresence` serializes EVERY non-private window into a full snapshot and
   broadcasts it every 2 seconds, unconditionally, audience or not.
3. The stale-prune timers call `setState` with a **new array/object even when
   nothing changed** (`prev.filter(...)` always returns a fresh reference), and
   both hooks live at the top of `App.tsx` — so the entire unmemoized app tree
   re-renders every 1.5s (cursors) forever, doing nothing.
4. With peers present, each inbound `cursor_move` (~30/sec per peer) calls
   `setCursors` at the App root — 30·P full-app re-renders per second.

After this plan: no cursor broadcasts and a slow presence heartbeat when alone,
inbound cursor updates coalesced to one state write per animation frame, and
prune ticks that change nothing no longer re-render anything.

## Current state

- `src/hooks/useMultiplayerCursors.ts` — mounted at `src/App.tsx:657`.
  - `:74-88` `handleMouseMove`: throttles to 32ms, then `sendCursor(x, y)`
    unconditionally (no peer check). Global `mousemove` listener attached at `:119`.
  - `:41-48` `upsertCursor`: `setCursors` per inbound broadcast frame.
  - `:50-53` prune (runs every 1.5s via `:121`):

```ts
const pruneStaleCursors = useCallback(() => {
  const cutoff = Date.now() - 5000;
  setCursors(prev => prev.filter(cursor => cursor.lastSeen >= cutoff)); // always new array
}, []);
```

  - `:103-107` on SUBSCRIBED it announces itself with `sendCursor(-100, -100)` —
    keep this; it is how peers learn you exist.

- `src/hooks/useItemPresence.ts` — mounted at `src/App.tsx:663`.
  - `:77` `const [remotePresence, setRemotePresence] = useState<Record<string, RemotePresenceState>>({});`
  - `:131-149` `sendSnapshot` serializes all items + all shared windows and broadcasts.
  - `:218-221` heartbeat:

```ts
heartbeatRef.current = window.setInterval(() => {
  sendSnapshot();
  pruneStaleUsers();
}, 2000);
```

- Repo convention: refs for mutable non-render state (`throttleRef`,
  `cleanupTimerRef` in the same files). Match it.

## Commands you will need

| Purpose   | Command             | Expected on success |
|-----------|---------------------|---------------------|
| Typecheck | `npm run typecheck` | exit 0              |
| Lint      | `npm run lint`      | exit 0              |
| Unit tests| `npm run test:unit` | all pass            |
| Build     | `npm run build`     | exit 0              |

## Scope

**In scope**:
- `src/hooks/useMultiplayerCursors.ts`
- `src/hooks/useItemPresence.ts`

**Out of scope**:
- `src/App.tsx` — no new props/params should be needed; both hooks can derive
  "peers present" from their own state (see steps). If you find you must change
  App.tsx, STOP.
- `src/lib/realtimeManager.ts` and the channel/broadcast plumbing — working and shared.
- Server code.

## Git workflow

- Branch: `perf/012-idle-realtime-chatter`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: No-op prunes must not allocate

In `useMultiplayerCursors.ts`, change `pruneStaleCursors` to bail out when
nothing is stale:

```ts
const pruneStaleCursors = useCallback(() => {
  const cutoff = Date.now() - 5000;
  setCursors(prev => {
    const next = prev.filter(cursor => cursor.lastSeen >= cutoff);
    return next.length === prev.length ? prev : next;
  });
}, []);
```

Apply the same "return `prev` when unchanged" guard to `pruneStaleUsers` in
`useItemPresence.ts` (it filters `remotePresence` by `lastSeen`; if no entry is
removed, return the previous object reference).

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Coalesce inbound cursor frames to one write per animation frame

In `useMultiplayerCursors.ts`, buffer inbound frames in a ref and flush via rAF:

```ts
const pendingRef = useRef<Map<string, CursorPresence>>(new Map());
const rafRef = useRef<number | null>(null);
const flushPending = useCallback(() => {
  rafRef.current = null;
  const pending = pendingRef.current;
  if (pending.size === 0) return;
  pendingRef.current = new Map();
  setCursors(prev => {
    const next = prev.filter(item => !pending.has(item.id));
    pending.forEach(cursor => next.push(cursor));
    return next;
  });
}, []);
const upsertCursor = useCallback((cursor: CursorPresence) => {
  if (!userId || cursor.id === userId) return;
  pendingRef.current.set(cursor.id, cursor);
  if (rafRef.current === null) rafRef.current = requestAnimationFrame(flushPending);
}, [userId, flushPending]);
```

Cancel `rafRef` in the effect cleanup (alongside the existing interval cleanup).

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Don't broadcast cursor moves with no audience

In the same hook, track whether any remote cursor has been seen:
`const hasPeersRef = useRef(false);` — set it `true` inside the
`cursor_move` broadcast handler (any frame from another id) and inside
`upsertCursor`; set it `false` when `cursors` empties (in `flushPending`/prune,
when the resulting list is empty). In `handleMouseMove`, bail out early when
`!hasPeersRef.current`. Also raise the send throttle at `:78` from `32` to `80`
(≈12 fps is plenty for a remote cursor).

Keep the `sendCursor(-100, -100)` announce on SUBSCRIBED (`:105`) — that is how
two clients discover each other: A announces on join, B (already subscribed)
receives it, sets `hasPeersRef=true`, and B's next real mousemove reaches A,
which flips A's flag too.

**Verify**: `npm run typecheck` → exit 0; `grep -n "80" src/hooks/useMultiplayerCursors.ts` shows the new throttle.

### Step 4: Adaptive presence heartbeat in `useItemPresence.ts`

Replace the fixed 2s interval (`:218-221`) with an adaptive one: 2000ms when
`Object.keys(remotePresence).length > 0`, else 10000ms. Implementation shape:
keep a single interval but store the current delay in a ref; when the
remote-presence emptiness flips, clear and re-create the interval with the new
delay (do this inside an effect keyed on `Object.keys(remotePresence).length > 0`).
Additionally, when a `presence_snapshot` from a NEW remote user arrives (first
entry added to `remotePresence`), call `sendSnapshot()` immediately so the
newcomer sees your windows without waiting up to 10s.

**Verify**: `npm run typecheck` → exit 0; `npm run lint` → exit 0.

### Step 5: Full verification

**Verify**: `npm run test:unit` → all pass; `npm run build` → exit 0.

## Test plan

- No existing unit tests cover these hooks (`git grep -l useMultiplayerCursors -- '*.test.*'`
  returns nothing at planning time — confirm). Don't build a WebSocket test rig
  for this; the gates above plus a two-browser manual smoke are the acceptance:
  open the same workspace in two browsers — cursors still appear both ways
  within a second of the second user joining; window presence still shows; close
  one browser — the other prunes it within ~10s.
- Solo smoke: with one browser open and DevTools → Network → WS frames visible,
  confirm no `cursor_move` frames while moving the mouse alone, and
  `presence_snapshot` frames at ~10s cadence instead of 2s.

## Done criteria

- [ ] `npm run typecheck`, `npm run lint`, `npm run test:unit`, `npm run build` all exit 0
- [ ] `pruneStaleCursors` and `pruneStaleUsers` return `prev` when nothing was removed (read the code)
- [ ] `handleMouseMove` contains an early return on the no-peers flag
- [ ] Heartbeat interval is 2000ms with peers / 10000ms alone
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back if:

- Two-browser smoke shows cursors never appearing for one side (the discovery
  handshake broke — see step 3's announce note) after one fix attempt.
- You need to add parameters to either hook's signature (App.tsx change) to get
  a peers signal — the design above avoids it; report instead.
- The excerpts don't match the live code.

## Maintenance notes

- If workspace presence later gains a server-side roster (who's online), replace
  the `hasPeersRef` inference with that roster — it's the cleaner signal.
- Plan 016 (memoization) further shrinks the blast radius of the remaining
  cursor state writes; this plan reduces their frequency.
- Deferred: diffing presence snapshots so identical payloads aren't re-sent —
  worth it only if WS traffic still shows in profiling after this lands.
