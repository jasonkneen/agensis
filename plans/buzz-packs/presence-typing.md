# Buzz pack: presence-typing — "Presence and typing indicators"

- **Pack**: `presence-typing`, rank 7, priority 60, domain `realtime`
- **Source**: `/Users/jkneen/Documents/GitHub/repo-grab/out/extract-pack/presence-typing/`
- **Stated target surface**: "server WebSocket bridges + presence store"
- **Verdict**: **adopt-modified, heavily narrowed** — see below
- **Planned against**: `main-next`, 2026-07-29

---

## 1. Verdict

**Adopt-modified, but ~85% of this pack is already built and shipped.** Agensis has
ephemeral, short-TTL, pub/sub-fanned-out presence that is deliberately kept out of the
durable message store. It has it three separate times over (workspace item presence,
cursors, huddle participants), each with its own TTL, its own refresh cadence, and a
written rationale for both numbers. The pack's two stated interfaces — "ephemeral online
set with TTL" and "typing signals that expire without durable storage" — are both
satisfied by `src/hooks/useItemPresence.ts` today.

The one genuine gap is small and specific, and it is not "build a presence store". It is
this: **the typing lane is fully built and never wired.** `PresenceSnapshotItem.typing`
exists on the wire (`src/hooks/useItemPresence.ts:9`), `ItemPresenceUser.typing` exists in
the shared types (`src/types/index.ts:502`), `setTyping` exists and is exported
(`src/hooks/useItemPresence.ts:168-173, :297`), and the sidebar already renders
`"<name> is typing"` when that flag is true (`src/components/layout/Sidebar.tsx:1685`,
`:1938`). Nothing anywhere in `src/` ever calls `setTyping` — a grep for it across the
whole frontend returns only its definition and its own return statement. Every human in
every workspace has been permanently reported as "is active", never "is typing", since
the feature was written.

So the recommendation is: **wire the existing typing lane with a lean dedicated frame
(2 engineer-days, frontend-only), decide explicitly and in writing that agents never emit
typing, and reject the "presence store" framing entirely.** A `workspace_presence` table
would be a regression: agensis already learned, in `database/neon-schema.sql:1041-1063`,
that presence must expire rather than be deleted, and it already pays for exactly one such
table (`huddle_presence`) where the cost is justified by a call that has to survive a
150s background-tab clamp. Workspace presence does not have that constraint and does not
need a row per person per workspace.

There is one thing worth adopting that the pack does **not** propose, and it is the
sharpest finding in this document: **the client-originated `broadcast` action on the
WebSocket has no rate limit** (`server/realtime.cjs:463-467` — authorize, then fan out,
no limiter, compare the `voiceStreamRateLimiter` two branches below at `:471-478`).
Typing indicators are the single most keystroke-coupled thing you can put on that path.
Wiring typing without bounding the path is how you find out.

### What already exists, with citations

| Capability the pack asks for | Where it already lives |
|---|---|
| Ephemeral online set, TTL, no durable store | `src/hooks/useItemPresence.ts` — channel `item-presence:<workspaceId>` (`:181`), `presence_snapshot` broadcast with `lastSeen` (`:132-150`), 7s prune (`:152-166`), explicit `presence_leave` on unload (`:220-226`) |
| Adaptive refresh so idle costs less | `useItemPresence.ts:245-257` — 2000ms with peers, 10000ms alone |
| Typing signal on the wire | `useItemPresence.ts:9` (`typing?: boolean` on the snapshot item), `:104`, `:115`, `:279` |
| Typing setter | `useItemPresence.ts:168-173` — **exported at `:297`, never called** |
| Typing rendered in the UI | `src/components/layout/Sidebar.tsx:1685`, `:1938` — `title={...person.typing ? ' is typing' : ' is active'}` |
| Cursor presence with TTL | `src/hooks/useMultiplayerCursors.ts` — channel `cursors:<workspaceId>` (`:113`), 5s TTL (`:64-72`), no-audience suppression (`:95`), 80ms throttle (`:98`) |
| Pub/sub fan-out | `server/realtime.cjs:268-278` `relayBroadcast` |
| Fan-out authorization | `server/realtime.cjs:339-343` `authorizeRealtimeBroadcast` -> `enforceWorkspaceRole(read)`; channel-name allowlist at `:301-307` |
| Mid-session revocation | `server/realtime.cjs:140-158` `revokeRealtimeAccessForMember` — a removed member's live subscriptions are dropped, not left running |
| Presence privacy model | `PresenceVisibilityMode` (`src/types/index.ts:495`), per-viewer state (`src/App.tsx:168`, `:433`, `:678`, `:896-908`), roster control (`src/components/presence/PresenceRoster.tsx:68-72`, `:485`) |
| Durable-with-expiry presence, where it is justified | `huddle_presence` (`database/neon-schema.sql:1055-1063`; DDL also in `server/huddles.cjs:627`), 30s heartbeat / 150s stale (`server/huddles.cjs:115-116`), `POST /backend/workspaces/:id/huddles/:huddleId/heartbeat` (`server/huddles.cjs:1417`) |
| Agent liveness | `updateAgentHeartbeat` (`server/agent-connections.cjs:794-819`), daemon beat every `heartbeatMs` default 15000 (`agensis-agent packages/agensis-cli/src/cli.mjs:87`, sent at `src/agensis.mjs:396`), socket liveness 15s ping / 8 missed pongs (`server/realtime.cjs:68`, `:86`), `hasMcpPresence` 40s TTL (`server/agent-connections.cjs:61-70`), `markAgentConnectionOffline` (`:270`) |
| Agent "is working" surfaced in chat | `src/lib/activityStatus.ts` — verb list (`:14-19`), live chip label with elapsed (`:94-98`), staleness rule (`:113`, `:145-152`, `:162-170`) |
| Human/agent presence merged at the view layer | `src/hooks/useWorkspacePresence.ts:119-145` — with a comment explaining why agents come from daemon rows and never from browser presence |

### What is genuinely missing

1. **`setTyping` is never called.** Dead lane, top to bottom.
2. **No server-authoritative roster.** Presence is peer-inferred: you know someone is here
   only because they are broadcasting. `plans/012-cut-idle-realtime-chatter.md:222-223`
   already flags this as the cleaner signal, deferred. Still the right call to defer — see
   the risk register.
3. **Presence is keyed to open floating windows.** `buildItems`
   (`useItemPresence.ts:90-121`) walks `windowsRef.current` and emits an item only for a
   non-minimized `chat`/`document` window. A DM or thread that is not open in a window
   contributes nothing, so there is no presence and can be no typing indicator in the
   sidebar-only reading path.
4. **No rate limit on client-originated broadcasts** (`server/realtime.cjs:463-467`).

---

## 2. What the pack actually proposes

The pack is thin, and it is fair to say so. Its two `code_anchors` are (a) a bare directory
listing of `crates/buzz-pubsub` (`Cargo.toml`, `src` — no source, no API, no TTL constants)
and (b) the first ~40 lines of buzz's `ARCHITECTURE.md`, which is a general description of
a Nostr relay and never mentions presence or typing at all. There is no behavioural detail
to transfer. The entire specification is the one-line description repeated four times
across `pack.json`, `PROMPT.md` and `recommendation.json`:

> Ephemeral presence (who is online) and typing indicators via short-TTL keys and pub/sub
> fan-out, separate from durable message store.

Plus two interfaces to preserve semantically: "ephemeral online set with TTL" and "typing
signals that expire without durable storage".

The acceptance checks are the useful part, and worth keeping: a test that drives the real
entry point, docs covering how agents and humans use it, and a proven TTL expiry.

### Where buzz's architecture does not transfer

- **Nostr `kind` integers as the extension mechanism.** Buzz adds a feature by defining a
  new event kind; every event is a signed Nostr event and the relay is the single source of
  truth for reads and writes. Agensis has two orthogonal transports — Postgres rows fanned
  out as `db_changes` (`server/realtime.cjs:199-266`) and ephemeral `broadcast` frames
  (`:268-278`) — and presence deliberately lives only on the second. That separation is
  agensis's version of buzz's "separate from durable message store", and it is already
  cleaner than buzz's, because agensis's ephemeral lane touches no storage at all.
- **A separate pub/sub crate with short-TTL keys.** This implies a Redis-shaped store.
  Agensis has no Redis and should not acquire one for this. The TTL here belongs in the
  *receiver*, not in a shared key store — which is what `useItemPresence.ts:152-166` and
  `useMultiplayerCursors.ts:64-72` already do.
- **Signed events / per-event auth.** Agensis authorizes at subscribe time and re-authorizes
  on membership change (`revokeRealtimeAccessForMember`). Presence frames are not
  individually authorized. That is a deliberate and correct trade for a signal with a 6s
  half-life; it is also why the missing rate limit matters.
- **"Community resolved by request host, fail closed."** Not applicable — agensis resolves
  workspace from the channel name (`workspaceIdFromRealtimeChannel:301-307`) and fails
  closed on an unrecognised prefix, which is the same property by a different route.

---

## 3. The coherent presence model across humans and agents

This is the part the pack does not address and the part worth getting written down.

**Humans and agents must stay on separate presence transports and merge only at the view
layer.** Agensis already does this, and `src/hooks/useWorkspacePresence.ts:119-124` says so
in a comment. This plan's contribution is to make it a rule and give the reason:

- A human's "typing" is a 2-8 second burst. It is a *prediction* ("something is about to
  arrive"), and its whole value is that it is short.
- An agent's equivalent is a multi-minute tool run. It is a *report* ("work is in
  progress, here is how long it has been going"). Rendering that as an animated three-dot
  typing indicator would mean an indicator that runs for six minutes, which reads as a
  hang, not as activity.
- Agents already have the correct surface, and it carries a clock:
  `activityChipLabel` -> `"Thinking 1m 56s"` (`src/lib/activityStatus.ts:94-98`).
- Critically, that surface *already learned this lesson the expensive way*.
  `isLiveActivityPlaceholder` and `ACTIVITY_STALE_MS = 60000`
  (`src/lib/activityStatus.ts:105-113`, `:154-170`) exist specifically because a
  placeholder went on claiming "Thinking 2m 11s" for hours after the agent had stopped. A
  naive agent typing indicator is that same bug with a nicer animation.

There is also a hard technical reason agents cannot emit typing on the presence channel
even if we wanted it: **a daemon socket has no `ws.userId`.** `finalizeAuthenticated`
(`server/realtime.cjs:379-384`) sets `ws.userId = userId`, and for an agent-token socket
`userId` is falsy by construction (`:389-391`). `authorizeRealtimeBroadcast` calls
`enforceWorkspaceRole(ws.userId, ...)` -> `assertWorkspaceRole`
(`shared/backend-core.cjs:683-699`), which throws `forbidden('You do not have access to
this workspace')` when no role and no inherited role resolve. So a daemon broadcasting on
`item-presence:<ws>` is rejected today. Adding agent typing would mean adding a *new
authorization path for daemon-originated broadcasts*, which is a security surface expansion
for a feature that is a worse version of one we already have. Do not.

### The staleness table

Every presence signal in agensis, its refresh, its TTL, and what the UI shows when the
signal stops. The new row is marked NEW.

| Signal | Source | Refresh | TTL | What the UI does on silence |
|---|---|---|---|---|
| Human item/window presence | browser broadcast | 2s with peers / 10s alone (`useItemPresence.ts:245-257`) | 7s (`:153`) | avatar disappears from the sidebar row |
| Human cursor | browser broadcast | <=80ms while moving, suppressed with no peers (`useMultiplayerCursors.ts:95-99`) | 5s (`:65`) | cursor vanishes |
| **Human typing (NEW)** | browser broadcast | re-arm at most 1 per 4s per target | 6s, carried as `ttlMs` in the frame | indicator clears on its own; **no stop frame is required for correctness** |
| Huddle participant | HTTP POST heartbeat | 30s (`server/huddles.cjs:115`) | 150s (`:116`) | `reaped_at` set, roster row removed |
| Agent daemon liveness | WS heartbeat + socket pings | 15s (`agensis-cli/src/cli.mjs:87`) | ~120s of missed pongs (`server/realtime.cjs:86`) | `markAgentConnectionOffline` -> `status='offline'` -> filtered out of the roster (`useWorkspacePresence.ts:126`) |
| Agent MCP presence | MCP poll | per poll | 40s (`server/agent-connections.cjs:61`) | `hasMcpPresence` false |
| Agent activity chip | placeholder message content | ~1/s content rewrite | 60s from `created_at + elapsed` (`activityStatus.ts:113`, `:145-152`) | chip stops claiming the run is live (`isLiveActivityPlaceholder:162-170`) |

**Design consequence, and the one non-obvious decision in this plan: the typing frame
carries a relative `ttlMs`, not an absolute `until` timestamp.** The receiver computes
`Date.now() + ttlMs` on arrival. `src/lib/activityStatus.ts:105-113` documents exactly why:
those timestamps are the server's and are compared against the browser's, so it had to buy
a full minute of slack just to absorb clock skew. A 6s typing TTL has no room for that
slack. Sending a duration eliminates the entire skew class instead of budgeting for it.

---

## 4. Cost: expected message volume, honestly

The project has a live finding that idle WebSocket chatter contributes to slowness
(`plans/012-cut-idle-realtime-chatter.md`, implemented — the current code matches its
steps 1-4). Adding typing on the wrong path would undo a meaningful part of that work.

### Current baseline

`relayBroadcast` (`server/realtime.cjs:268-278`) iterates every connected socket and does
**not** exclude the sender. Every subscriber to `item-presence:<ws>` — including the
originator, which discards it at `useItemPresence.ts:187` — receives every snapshot. So for
P browsers in a workspace, server sends per snapshot round = P^2.

A `presence_snapshot` payload contains every non-private window via `publicWindowSnapshot`
(`useItemPresence.ts:46-67`, 18 fields each) plus the item list. With 8 windows open that
is roughly 1.5-2 KB.

| P (browsers in workspace) | Snapshot cadence | Server sends/sec | Approx egress |
|---|---|---|---|
| 1 (alone) | 10s | 0.1 | negligible |
| 2 | 2s | 2 | ~4 KB/s |
| 5 | 2s | 12.5 | ~25 KB/s |
| 10 | 2s | 50 | ~100 KB/s |

That is the cost of a workspace in which nobody is doing anything.

### Typing, done wrong

`setTyping` as currently written calls `sendSnapshot()` (`useItemPresence.ts:172`). If you
wire it to the composer's `handleInputChange`
(`src/components/windows/ChatWindowContent.tsx:771`) as-is, every keystroke sends a full
~2 KB snapshot. A 60 wpm typist is ~5 chars/sec:

- 5 snapshots/sec x P fan-out x 2 KB. At P=5: **50 KB/s from one person typing one
  sentence** — four times the entire idle load of the workspace.

This is the trap. Do not reuse `sendSnapshot` for typing.

### Typing, done right

A dedicated lean frame on the same channel:

```
{ v: 1, userId, name, color, scope: 'chat' | 'document', itemId, ttlMs }
```

Roughly 130-160 bytes serialized. Emission rule: send on the first keystroke of a burst,
then re-arm at most once per `TYPING_REARM_MS` (4000) while typing continues; send one
`ttlMs: 0` clear on send / blur / empty-draft, treated as best-effort.

| P | Typing frames/sec (1 active typist) | Server sends/sec | Approx egress | As % of existing presence traffic |
|---|---|---|---|---|
| 2 | 0.25 | 0.5 | ~75 B/s | ~2% |
| 5 | 0.25 | 1.25 | ~190 B/s | ~0.8% |
| 10 | 0.25 | 2.5 | ~375 B/s | ~0.4% |

Even with three people typing at once in a 10-person workspace this adds ~7.5 sends/sec
against an existing floor of 50. **It is worth its traffic in this shape, and it is not in
any other shape.** If the throttle or the lean frame is dropped in review, the feature
should be dropped with it.

### One optional change that pays for the whole feature

Exclude the sender from client-originated broadcasts. All three consumers of the broadcast
channels already discard self-echo explicitly and would be unaffected:

- `useItemPresence.ts:187` — `if (!snapshot.userId || snapshot.userId === userId) return;`
- `useMultiplayerCursors.ts:58` — `if (!userId || cursor.id === userId) return;`
- `useCanvasObjects.ts:132`, `:141` — `if (senderId && userId && senderId === userId) return;`

Suppressing the echo removes P sends per round, i.e. cuts presence fan-out from P^2 to
P(P-1) — a 50% reduction at P=2, 20% at P=5. That is strictly larger than everything typing
adds. It is ~5 lines in `relayBroadcast` plus one call-site argument, and it is listed as
step 5 below, gated behind its own test.

---

## 5. Impact on our system

### Subsystems touched

| Subsystem | Change |
|---|---|
| `src/hooks/useItemPresence.ts` | New lean typing lane alongside the existing snapshot lane. `setTyping` keeps its signature but stops calling `sendSnapshot`. |
| `src/lib/` (new `typingPresence.ts`) | Pure reducer + throttle policy, extracted so it is testable under the existing runner (see section 7 — there is no `@testing-library/react` in this repo). |
| `src/components/windows/ChatWindowContent.tsx` | One new optional prop, called from the existing `handleInputChange` (`:771`) and cleared in the existing send path. |
| `src/App.tsx` | Pass `itemPresence.setTyping` down; it is currently computed and thrown away. |
| `src/components/layout/Sidebar.tsx` | No change required — `:1685` and `:1938` already read `person.typing`. Optionally a visible dot instead of a `title` attribute (see "not in v1"). |
| `server/realtime.cjs` | Optional: per-socket broadcast rate limiter; optional: self-echo suppression. No change at all if v1 ships frontend-only. |

### What it breaks / forces a migration of

**Nothing.** No schema change, no new table, no new route, no new WS message type, no
change to the channel grammar. The typing frame is a new `event` name on an existing
authorized broadcast channel; an older client that has not been redeployed simply never
subscribes to that event and never sees it (`relayBroadcast:270-274` matches on channel
*and* event). Netlify and Fly deploy independently, and this is forward- and
backward-compatible across that gap by construction.

The `v: 1` field in the frame exists so the next shape change can be additive too.

### Interaction with work in flight

- **`self-update-supervise` (pack 12, shipped in daemon 0.1.43/0.1.44)**: no overlap. That
  is daemon-side; this is browser-side and does not touch `packages/agensis-cli`.
- **Channel bridges (`server/channel-bridges.cjs`)**: bridged participants (telegram,
  slack, whatsapp, signal, openclaw) have no browser socket and therefore no presence and
  no typing. This is correct and should be stated in the docs rather than papered over —
  a bridged human appearing as permanently absent is honest; synthesising presence for
  them from message timing would be a lie.
- **`thread_harvests` review UI, tool-step/thread parenting fixes**: no interaction.
- **Plan 012**: this plan is a direct continuation of it and must not regress it. Its
  maintenance note (`plans/012-cut-idle-realtime-chatter.md:222-223`) anticipated a
  server-side roster; this plan deliberately does not build one.
- **Plan 016 (memoize window tree)**: relevant. Typing state changes at the App root would
  re-render the tree. The design below keeps typing state inside `useItemPresence`'s
  existing `remotePresence` object, which already flows through the same memo boundaries,
  so it adds no new re-render source at the root beyond the ones already there.

### Security and permissions

- **RBAC**: the typing frame rides `item-presence:<workspaceId>`, so it inherits
  `authorizeRealtimeBroadcast` -> `enforceWorkspaceRole(userId, workspaceId, 'read')`
  (`server/realtime.cjs:339-343`). Read is the correct floor: seeing who is typing is a
  read of workspace activity. No `write` or `manage` capability is involved and none should
  be added.
- **Connect-token model**: unaffected. A daemon socket cannot broadcast on this channel at
  all (section 3), and this plan does not change that.
- **Read-only client tables (`shared/backend-core.cjs` `DB_TABLE_ACCESS`)**: unaffected —
  no table is created or written. This is the strongest argument against the pack's
  "presence store": a new table would need a `DB_TABLE_ACCESS` entry and an `ALLOWED_TABLES`
  entry (`shared/backend-core.cjs:31`, `:187`) in two runtimes kept in sync by hand
  (`:209-210`), and would then be reachable through the generic `/backend/db/*` routes.
- **Pre-existing information exposure, which this feature inherits but does not create**:
  `item-presence:<workspaceId>` is workspace-wide, and today's `presence_snapshot` already
  carries `items[].itemId` — session and document ids — to every member with `read`,
  including for sessions that member cannot open. Adding typing broadcasts the same class
  of identifier at a higher rate. The current mitigation is UI-layer only: the sidebar
  renders presence for sessions it already lists. **This is not an authorization boundary
  and should not be described as one.**
  The structural fix is per-item channel names (`item-presence:<workspaceId>:<sessionId>`),
  and it is blocked: `workspaceIdFromRealtimeChannel` (`server/realtime.cjs:301-307`)
  parses `prefix:workspaceId` and returns `null` for any channel with a second colon
  (`if (rest.length > 0 || !workspaceId) return null`). Changing that grammar is a server
  change with blast radius across `canvas`, `cursors`, `item-presence`, `agent-presence`
  and `agent-status`. **Out of scope for v1; recorded as risk R2.**
- **Unbounded broadcast** (`server/realtime.cjs:463-467`): any authenticated member can
  drive `relayBroadcast` at line rate to every other member of their workspace, with no
  limiter, at arbitrary payload size. `sendWs` drops on a 4 MB backpressure threshold
  (`:111`) which bounds memory per socket but not CPU or fan-out. This exists today. Typing
  makes the path hotter and more obviously reachable from a keystroke handler. Fixing it is
  step 5.

---

## 6. Exact work breakdown

### Files

**Create**

| File | Reason |
|---|---|
| `src/lib/typingPresence.ts` | Pure typing state: frame shape, emit-throttle decision, receiver reducer, expiry. Extracted from the hook so it is unit-testable — see section 7 for why this is mandatory, not stylistic. |
| `tests/unit/typingPresence.test.ts` | Unit tests for the above. Must be `.test.ts` directly under `tests/unit/`. |
| `tests/unit/itemPresenceTyping.test.ts` | Mounts a harness component driving the real `useItemPresence` hook against a fake transport, so the tests hit the real entry point (pack acceptance check 1). |
| `tests/realtime-broadcast-limit.test.cjs` | Backend: the rate limiter in step 5. Must be `tests/*.test.cjs`, non-recursive. |

**Modify**

| File | Reason |
|---|---|
| `src/hooks/useItemPresence.ts` | Add the `typing` broadcast event (send + receive + expiry); change `setTyping` to emit the lean frame instead of calling `sendSnapshot` (`:172`); merge live typing into the derived `chatPresence`/`documentPresence` maps (`:259-290`) so the existing consumers light up with no prop changes. |
| `src/App.tsx` | Thread `itemPresence.setTyping` to the chat window props. `itemPresence` is already in scope at `:850`. |
| `src/components/windows/ChatWindowContent.tsx` | New optional `onTypingChange?: (typing: boolean) => void` prop; call it from `handleInputChange` (`:771`) and clear it in `handleSend` and on composer blur. |
| `src/components/windows/WindowBodies.tsx` | Pass the new prop through (`:83`) — it is the memo boundary for chat windows. |
| `AGENTS.md` | Document the presence model: two lanes, the staleness table from section 3, and the rule that agents do not emit typing. Pack acceptance check 3. |
| `server/realtime.cjs` (steps 5-6 only) | Per-socket broadcast rate limiter; sender exclusion. |

**Explicitly not modified**

- `src/components/layout/Sidebar.tsx` — `:1685` and `:1938` already do the right thing.
- `src/types/index.ts` — `ItemPresenceUser.typing` already exists at `:502`.
- `database/neon-schema.sql`, `ensureRuntimeSchema` — no DDL.
- `packages/agensis-cli/*` in the agensis-agent repo — no daemon change.

### New DB tables / columns

**None.** No DDL, no `ensureRuntimeSchema()` entry, no `database/neon-schema.sql` change,
no `database/migrations` entry. The three-place schema-sync rule
(`AGENTS.md:25-29`) does not apply to this change. This is a deliberate design outcome, not
an omission: the pack asks for storage-free ephemeral signals, and Postgres is the wrong
place for a value with a 6-second lifetime.

### New WS message types

One new broadcast **event** on an existing **channel**. No new `action`, no new server
handler, no new authorization path.

- **Channel**: `item-presence:<workspaceId>` (existing, allowlisted at
  `server/realtime.cjs:305`)
- **Event**: `typing`
- **Required role**: `read` on the workspace, enforced by the existing
  `authorizeRealtimeBroadcast` (`server/realtime.cjs:339-343`). Unchanged.
- **Payload**:

```
{
  v: 1,                                // frame version, for additive changes later
  userId: string,                      // sender; receivers drop their own
  name: string,                        // display name, same source as presence_snapshot
  color: string,                       // same palette as presence_snapshot
  scope: 'chat' | 'document',
  itemId: string,                      // session id or document id
  ttlMs: number                        // RELATIVE. 0 means "stopped". Never absolute.
}
```

Constants, colocated in `src/lib/typingPresence.ts`:

- `TYPING_TTL_MS = 6000` — how long a received frame keeps the indicator up.
- `TYPING_REARM_MS = 4000` — minimum gap between outbound frames for the same target.
  Strictly less than the TTL so a continuous typist never flickers.
- `TYPING_MAX_TARGETS = 4` — cap on concurrently-tracked typing targets per sender, so a
  scripted client cannot turn one socket into a fan-out multiplier.

### Frontend components and where they mount

Nothing new mounts. The signal reaches the existing surfaces:

- `src/components/layout/Sidebar.tsx:1685` and `:1938` — already read `person.typing` from
  `chatPresence[sessionId]` / `documentPresence[docId]`, which `App.tsx:2299-2300` already
  passes. Once `typing` is populated the tooltip becomes true for the first time.
- Optionally (v1.1, not v1) a visible three-dot indicator in the chat window under the
  transcript. Deliberately deferred — see "not in v1".

### Build sequence

**Step 1 — vertical slice, no UI change beyond the existing tooltip (0.5 day).**
Create `src/lib/typingPresence.ts` with the frame shape, `shouldEmit(state, now)` throttle
decision, `applyTypingFrame(state, frame, now)` reducer, and `pruneExpired(state, now)`.
Pure, no React, no transport. Unit-test it. This is the slice that proves the TTL semantics
before any wiring exists.

**Step 2 — wire the transport (0.5 day).**
In `useItemPresence.ts`: subscribe to the `typing` event on the existing channel; hold
received frames in a ref-backed map with expiry; rewrite `setTyping` (`:168-173`) to consult
`shouldEmit` and send the lean frame instead of `sendSnapshot()`; fold live typing into the
`chatPresence`/`documentPresence` memo (`:259-290`). A separate prune tick is not needed —
reuse the existing heartbeat interval (`:245-257`), which already runs at 2s with peers and
10s alone, and note that alone means nobody can be typing at you anyway.

**Step 3 — emit from the composer (0.25 day).**
`ChatWindowContent`: add `onTypingChange`, call it `true` from `handleInputChange:771` and
`false` from `handleSend` / composer blur / draft-cleared. Thread the prop through
`WindowBodies.tsx:83` and `App.tsx`. At this point the sidebar tooltip is live and correct.

**Step 4 — tests and docs (0.5 day).**
`tests/unit/itemPresenceTyping.test.ts` driving the real hook; `AGENTS.md` section.

**Step 5 (optional, server, +0.5 day) — bound the broadcast path.**
Add a per-socket limiter using the existing `createRateLimiter`
(`shared/backend-core.cjs:1044`, already exported at `:1737`) at
`server/realtime.cjs:463-467`, keyed on the socket rather than the user so one tab cannot
starve another. Suggested budget: 240 broadcasts/minute/socket, which is roughly 4x what a
peer-heavy cursor session legitimately produces at the 80ms throttle
(`useMultiplayerCursors.ts:98`). Over budget: drop the frame silently and send one
`{ type: 'error', code: 'rate_limited' }` per window, never a disconnect — a mid-turn
disconnect is exactly the failure mode `LIVENESS_MAX_MISSED_PONGS` was raised to 8 to avoid
(`server/realtime.cjs:70-86`).

**Step 6 (optional, server, +0.25 day) — suppress self-echo.**
Add an optional `excludeWs` parameter to `relayBroadcast` (`server/realtime.cjs:268-278`)
and pass the originating socket from the client-originated branch at `:465` only. Do **not**
apply it to server-originated calls (`:218` `agent_status`), which have no originating
socket. Safe because all three consumers already discard self-echo (cited in section 4).

Steps 5 and 6 are separable and can ship in either order, or not at all. Steps 1-4 are
frontend-only and need no `fly deploy`.

---

## 7. Test plan

### Runner globs — verified, and they are narrower than expected

- **Frontend**: `npm run test:unit` -> `vitest run`, and `vitest.config.ts:8` sets
  `include: ['tests/unit/**/*.test.ts']`. **`.test.tsx` is not matched.** There are
  currently zero `.test.tsx` files under `tests/unit/`, which is why nobody has hit this.
  Existing component tests work around it by using `createElement` instead of JSX in a
  `.ts` file — see `tests/unit/presenceRoster.test.ts:1-6`. Follow that.
- **Backend**: `npm test` -> `node --test tests/*.test.cjs` (`package.json:15`). Non-recursive,
  `.cjs` only. A `.mjs` file or one in a subdirectory never runs.
- **There is no `@testing-library/react` in this repo.** `renderHook` does not exist here.
  Hook tests must mount a harness component with `react-dom/client` + `act`, exactly as
  `tests/unit/presenceRoster.test.ts` does. This is the reason the pure logic is extracted
  into `src/lib/typingPresence.ts` in step 1 rather than living inline in the hook.

### Files

| File | Runner | Covers |
|---|---|---|
| `tests/unit/typingPresence.test.ts` | vitest | The pure reducer, throttle and expiry |
| `tests/unit/itemPresenceTyping.test.ts` | vitest | The real hook against a fake transport (pack acceptance check 1) |
| `tests/realtime-broadcast-limit.test.cjs` | node:test | Step 5's limiter, if built |

### Invariants worth pinning, and the mutation that must break each

1. **A received typing frame expires on its own; no stop frame is needed.**
   Test: apply a frame with `ttlMs: 6000`, advance a fake clock to +6001, assert the
   indicator is gone — without ever delivering a stop frame.
   *Mutation that must break it*: make `pruneExpired` a no-op -> fails.
   *Mutation that must NOT break it*: delete the outbound stop-frame send entirely -> still
   passes. This second half is the point: it proves the TTL is load-bearing and the stop
   frame is only an optimisation, which is the whole answer to "what does the UI show when
   the signal stops".

2. **Typing never sends a window snapshot.**
   Test: drive the real hook (harness mount), fire 20 `setTyping(true)` calls, assert every
   frame the fake transport saw has `event === 'typing'` and a serialized length under 256
   bytes, and that zero `presence_snapshot` frames were sent by the typing path.
   *Mutation*: revert `setTyping` to call `sendSnapshot()` (its current body at
   `useItemPresence.ts:172`) -> fails on both the event name and the size.
   This is the single most important test in the plan. It is the guard on the 50 KB/s
   regression quantified in section 4.

3. **Re-arm is throttled.**
   Test: `shouldEmit` with 40 keystrokes spread over 10 simulated seconds yields exactly 3
   emissions (t=0, t~4s, t~8s).
   *Mutation*: remove the `TYPING_REARM_MS` comparison -> 40 emissions, fails.

4. **A sender ignores its own typing frames.**
   Test: deliver a frame whose `userId` equals the local user; assert no state change.
   *Mutation*: remove the self-check -> the local user appears in their own typing list,
   fails.

5. **`ttlMs` is relative, and a skewed sender cannot suppress the indicator.**
   Test: deliver a frame constructed as if the sender's clock is 5 minutes behind; assert
   the indicator still shows for the full 6s from *arrival*.
   *Mutation*: change the frame to carry an absolute `until` and compare against
   `Date.now()` -> the indicator never renders, fails.
   This is the concrete guard on the failure class documented at
   `src/lib/activityStatus.ts:105-113`.

6. **Concurrent typing targets are capped.**
   Test: emit for 10 distinct `itemId`s; assert at most `TYPING_MAX_TARGETS` outbound
   frames per re-arm window.
   *Mutation*: remove the cap -> fails.

7. **(Step 5 only) The broadcast limiter drops frames but never disconnects.**
   Test: drive `attachRealtime`'s message handler past the budget on a stub socket; assert
   the excess frames do not reach `relayBroadcast`, that `ws.close` was never called, and
   that exactly one `rate_limited` error was sent.
   *Mutation*: replace the drop with a `ws.close(1008, ...)` -> fails on the close
   assertion. That mutation is the actual danger here, and it is why the assertion is
   phrased as "never closes" rather than "drops".

### On vacuous tests

Mock-DB vacuity does not apply — this feature touches no database. The equivalent trap
here is a **fake channel that replays what the emitter sent**, which would test the fake.
The fake transport in `itemPresenceTyping.test.ts` must be a dumb byte pipe: it records
outbound frames and lets the test hand-construct inbound ones. It must never derive an
inbound frame from an outbound one, and it must never know what `TYPING_TTL_MS` is.

---

## 8. Migration and rollout

### Data migration

**None.** No table, no column, no backfill, no reversibility question. Presence state has
never been persisted and this does not change that.

### Deploy lanes

| Lane | Needed? | Why |
|---|---|---|
| **Netlify** (frontend, `src/**`) | **Yes** — steps 1-4 | The entire v1 is `src/` |
| **`fly deploy`** (backend + DDL) | **Only for steps 5-6** | `server/realtime.cjs` is server code. Steps 1-4 touch no server file. |
| **npm publish `@agensis/agensis-agent`** | **No** | No daemon change |
| **Local daemon restart** | **No** | No daemon change |

Note the ordering rule if steps 5-6 are included: Fly before Netlify, so the frontend never
calls a server behaviour that is not live yet. In this specific case the ordering does not
actually matter — the limiter and the echo suppression are both invisible to a client that
has not been redeployed — but keep the habit.

### Feature flag and rollback

Steps 1-4 need no flag, because the failure mode is inert rather than harmful: with no
`onTypingChange` prop wired, `setTyping` is never called and the frontend behaves exactly as
it does today. If a runtime problem appears, the smallest revert is removing the
`onTypingChange` prop pass-through in `App.tsx` — one line, no server involvement, live on
the next Netlify deploy.

"Rollback" concretely means: `git revert` the frontend commit, push, Netlify redeploys.
There is no data to unwind and no schema to reverse. For steps 5-6, rollback is a
`fly deploy` of the previous commit; the limiter has no persistent state
(`createRateLimiter` is per-warm-process — `shared/backend-core.cjs:490`, `:1081-1094`),
so a rollback takes effect on the next machine boot with no residue.

If a staged rollout is wanted anyway, the natural gate is a constant
`TYPING_ENABLED` in `src/lib/typingPresence.ts` consulted by `shouldEmit` — receivers stay
tolerant either way, so a mixed fleet is safe with no coordination.

---

## 9. Risk register

Ranked. R1 and R2 are the two that matter.

**R1 — Traffic regression from reusing `sendSnapshot` (likelihood: high without a guard;
impact: high).** `setTyping`'s current body calls `sendSnapshot()`, and the obvious
implementation is to leave it alone and just call it from the composer. That is a 20x
traffic increase on the exact path plan 012 was written to fix, and it would land silently
because there is no automated traffic budget in this repo.
*Mitigation*: test invariant 2 is the guard, and it is written to fail on precisely that
mutation. Also add a one-line comment at `useItemPresence.ts:168` recording why the lean
frame exists, since a future reader's instinct will be to unify the two paths.

**R2 — Session-id exposure on a workspace-wide channel (likelihood: certain; impact:
medium; pre-existing).** `item-presence:<workspaceId>` fans to every member with `read`,
and the frame carries `itemId`. A member who cannot open a given DM still learns that it
exists and that someone is typing in it. This is true of `presence_snapshot` today; typing
raises the rate but not the class. **This is a security regression only if someone
describes the UI filter as an access control.** The structural fix (per-item channel names)
is blocked by the `prefix:workspaceId` channel grammar at `server/realtime.cjs:301-307`.
*Mitigation for v1*: never emit a typing frame for a session the sender reached through a
private/DM path — gate the emit in `ChatWindowContent` on the existing
`isDirectMessage` prop (`:346`) until the channel grammar is widened. This is a real,
cheap, one-condition mitigation and it should be in v1.

**R3 — No rate limit on the broadcast path (likelihood: low; impact: high; pre-existing).**
Any member can flood `relayBroadcast` to the whole workspace. Not introduced by this
feature, but this feature makes the path reachable from a keystroke handler and therefore
much easier to hit by accident (an infinite render loop in a composer would do it).
*Mitigation*: step 5. If step 5 is cut, say so explicitly in the PR rather than letting it
be forgotten.

**R4 — Indicator that lies after a tab dies (likelihood: medium; impact: low).**
`presence_leave` fires only on `beforeunload` (`useItemPresence.ts:220-228`), which is
unreliable on mobile Safari and on a force-quit. A typing indicator would persist.
*Mitigation*: the 6s TTL already bounds this to 6 seconds, which is the entire reason the
TTL is short and receiver-side. Explicitly do not add a "stop" reliability mechanism.

**R5 — Re-render pressure at the App root (likelihood: low; impact: low).**
`useItemPresence` lives at `src/App.tsx:850`, so typing state changes re-render the tree.
Plan 012 fixed exactly this class for prunes, and plan 016 shrank the blast radius.
*Mitigation*: keep typing inside the existing `remotePresence` state object so it flows
through the same memo boundaries as presence does now; return the previous reference when
nothing changed, matching the pattern at `useItemPresence.ts:152-166`.

**R6 — Test lands outside a runner glob (likelihood: medium; impact: medium).**
The brief notes this has bitten twice. `.test.tsx` under `tests/unit/` silently never runs
(`vitest.config.ts:8`), and so does anything under `tests/**/` for the backend runner
(`package.json:15`).
*Mitigation*: after writing each test file, run its runner and confirm the new test name
appears in the output. Not "the suite passed" — the specific test name.

**No data-loss risk exists in this plan.** Nothing is written, deleted or migrated.

### Effort

| Scope | Estimate | Confidence |
|---|---|---|
| Steps 1-4 (v1, frontend only, Netlify) | **2 engineer-days** | High |
| Step 5 (broadcast rate limiter, Fly) | +0.5 day | Medium |
| Step 6 (self-echo suppression, Fly) | +0.25 day | High |
| **Total if all six** | **~2.75 engineer-days** | Medium-high |

**Biggest unknown**: how `ChatWindowContent`'s composer behaves under the throttle in
practice — specifically whether a slash-command / mention picker interaction
(`handleInputChange:771` also drives `docPickerQuery`, `groupPickerQuery` and the mention
state) produces bursts that the 4s re-arm handles gracefully or that feel laggy to the
person watching. That is a 30-minute two-browser smoke test, not a design risk, but it is
the thing most likely to send step 3 back for a second pass.

### Deliberately NOT in v1

1. **A `workspace_presence` table or any server-side presence store.** The pack's
   `target_surface` says "presence store"; agensis does not need one and would pay for it
   in `ALLOWED_TABLES` + `DB_TABLE_ACCESS` upkeep across two runtimes.
2. **A server-authoritative roster.** Deferred with plan 012's own note
   (`plans/012-cut-idle-realtime-chatter.md:222-223`). It is the cleaner signal and it is a
   4-6 day project touching subscription lifecycle, reconnect semantics and the roster UI.
   Not justified by a typing indicator.
3. **Agent typing indicators.** Rejected on the merits in section 3, and blocked by
   daemon-socket authorization anyway. Agents keep the activity chip.
4. **Typing in DMs.** Gated off in v1 as R2's mitigation, until the channel grammar can
   carry an item scope.
5. **A visible three-dot animation in the chat transcript.** v1 lights up the existing
   sidebar tooltip only. Adding an animated element to the transcript is a design decision
   with its own review, and it should not ride in on a transport change.
6. **Presence for bridged channel participants** (telegram/slack/whatsapp/signal/openclaw).
   They have no socket. Reporting them as absent is honest; synthesising presence from
   message timing is not.
7. **Per-item channel names.** Requires changing `workspaceIdFromRealtimeChannel`
   (`server/realtime.cjs:301-307`), which every broadcast channel in the product depends on.
8. **Diffing presence snapshots so identical payloads are not re-sent.** Already recorded
   as deferred at `plans/012-cut-idle-realtime-chatter.md:226-227`, and step 6 (self-echo
   suppression) is a strictly larger win for strictly less code.

---

## 10. Notes for the implementer

- One observation found while reading, out of scope and not worth its own change:
  `useItemPresence`'s channel effect (`:236`) depends on `sendSnapshot`, whose identity
  changes when `activeLayerId` changes — so switching canvas layers tears down and
  re-subscribes the presence channel. Low severity (it costs one unsubscribe/subscribe
  round trip per layer switch) and it is pre-existing. Do not fix it as part of this work;
  note it if you touch that effect anyway.
- The `heartbeatMs` default cited above (15000) is from the **agensis-agent** repo
  (`packages/agensis-cli/src/cli.mjs:87`), not this one. That repo's `packages/` directory
  does not exist inside `agensis`; the daemon lives at
  `/Users/jkneen/Documents/GitHub/agensis-agent`.
- Pack acceptance check 4 ("presence/typing expires after TTL in a test or documented
  manual check") is satisfied by test invariant 1 above. Acceptance check 2 ("no verbatim
  file copy") is trivially satisfied — there was no source in the pack to copy.
