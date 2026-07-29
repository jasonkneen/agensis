# FB-005 — @coder-cli logs many spurious "agent connected" events, plus 2 smaller counting bugs

- **Task ID:** `16fe8a23-a876-461f-891b-ff90b405b2d8`
- **Reporter:** The Oracle (56bf0ff4-f573-435e-95a2-865b9c42ebe9)
- **Page:** /app — Main
- **Status:** todo → done (this writeup only; no code changed)

## Original message

> @coder-cli logged 13 "agent connected" events over ~17 hours against 1 disconnect. Timestamps, Central:
>   yesterday  21:18, 23:19
>   today      00:35, 00:57, 01:27, 04:31, 05:05, 05:41, 06:10, 09:08, 09:56, 10:58, 13:53
>   disconnect 09:56 only — followed by a reconnect the same second
> The Activity tab badge agrees: Agents 14 = 13 connects + 1 disconnect.
> Disconnects do get logged — I pressed Disconnect deliberately and got two events, 19:25:11 and 19:25:17, six seconds apart from one click. So the twelve missing ones are real absences, not a logging gap. And one action producing two disconnects is its own question.
> Worth knowing: I never ran a daemon command in a terminal. I connected @coder-cli by clicking Connect in the Agents panel. Its description says "A local coding agent that runs on your machine via the daemon", runtime shows Remote.
> Two smaller ones: the agent filter counts sum to 9 against 8 actual agents, and the host-folders placeholder shows a macOS path to a Windows user. Both trivial
> - The Oracle
>
> Page: /app — Main

## What I found in the codebase

Four distinct issues, all confirmed:

### 1. 13 connects vs 1 disconnect
`logConnectionActivity` is only called from two places: `registerAgentConnection` logs `agent_connected` **unconditionally** on every WS registration (`server/agent-connections.cjs:641`), while `markConnectionOffline` logs `agent_disconnected` only when its `UPDATE ... where id = $1` matches a row (`server/agent-connections.cjs:326-334`). The pairing breaks at `reconcileAgentConnectionsAtStartup` (`server/agent-connections.cjs:345-359`), which bulk-flips every stale connection row to `offline` on process boot via a raw `UPDATE ... where status <> 'offline'` — **deliberately without** calling `logConnectionActivity`. The comment at `server/index.cjs:6309-6314` confirms this is intentional, to avoid a "disconnect storm" in the activity bell on every daemon restart. Net effect: every backend restart/redeploy silently drops the pending disconnect for whatever was connected, while the next reconnect always logs a fresh `agent_connected`. Over ~17 hours with routine backend deploys, that produces exactly the 13:1 skew reported.

### 2. One Disconnect click → two disconnect events
`closeTakenAgentDaemons` (`server/agent-connections.cjs:119-134`) calls `markConnectionOffline(entry.connectionId, {evicted:true})` explicitly — logging disconnect #1 — then calls `entry.ws.close(...)`. That close is async; when the socket actually finishes closing, `ws.on('close', ...)` in `server/realtime.cjs:555-561` unconditionally calls `markAgentConnectionOffline(ws)` → `markConnectionOffline(ws.agentConnectionId)` again for the **same connectionId** (`ws.agentConnectionId` is never cleared). The row still exists (just flipped to offline), so the second `UPDATE` still matches and logs again — disconnect #2, a few seconds later, matching the reported 6-second gap.

### 3. Agent filter counts sum to 9 vs 8 actual agents
`src/components/windows/AgentsWindowContent.tsx:822-842` renders a derived "Active" chip (`presenceCounts.busy + presenceCounts.idle`) in the same row as the four mutually-exclusive filter chips (Busy/Idle/Disconnected/Inactive, lines 843-863, which do correctly sum to `agents.length`). "Active" isn't a fifth exclusive bucket — it's Busy+Idle again — so summing every visible chip double-counts whatever's busy/idle: 8 agents with 1 active → Active(1)+Busy+Idle+Disconnected+Inactive = 9.

### 4. Host-folders placeholder shows a macOS path
`src/components/windows/AgentsWindowContent.tsx:2988` hardcodes `placeholder="/Users/name/Documents/GitHub/project"` regardless of the connecting agent's actual OS.

## Recommendation

1. For the connect/disconnect skew: either log a (batched/rate-limited or distinctly-typed, e.g. `agent_disconnected_restart`) event for rows the startup sweep flips offline, or suppress the next `agent_connected` log when there wasn't already a known live connection for that agent — so a restart-triggered reconnect doesn't read as a brand-new connect either.
2. For the double disconnect: guard the SQL at `server/agent-connections.cjs:326-330` with `and status <> 'offline'` so a second call against an already-offlined row updates 0 rows and skips logging — simplest fix — or clear `ws.agentConnectionId` right after the explicit `markConnectionOffline` call.
3. For the count mismatch: stop treating "Active" as a peer chip alongside the four exclusive ones (or drop it — Busy+Idle already conveys the same info).
4. For the placeholder: derive the example path from the connecting daemon's actual `host`/`cwd` (already tracked per-connection — see `agent_connections.host`/`.cwd`, and `entry.host`/`entry.cwd` in `server/agent-connections.cjs:543-544`) and format Windows-style (`C:\Users\...`) or Linux-style (`/home/...`) accordingly.

Items 3 and 4 are trivial as the reporter noted; items 1 and 2 are the real fix (activity-log noise from an intentional-but-incomplete startup-sweep tradeoff).
