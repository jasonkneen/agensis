# Agent Chat & Daemon — Status Check

**Date:** 2026-06-29
**Backend:** Fly (`agensis-backend`, Frankfurt `fra`) → Neon (`neondb`, eu-central-1)
**Frontend:** Netlify (`agensis.io`) — static SPA, points at the Fly backend for HTTP + WebSocket
**Login:** `jason@bouncingfish.com` (you set your own password; the earlier temp no longer works)

## Shipped & verified this session

| Area | Fix | Verified | Commit |
|---|---|---|---|
| **DMs / streaming / threading** | Root cause: `agent_jobs.metadata` stored as corrupted jsonb array → `responseMessageId`/`threadParentId` unreadable. Hardened `parseJsonObject` to recover it. | DM: Coder replies, placeholder finalizes, 0 orphaned "Thinking" | `baf6b2e` area |
| **Thinking counter** | Client-side `ThinkingIndicator` ticks from `created_at` (independent of realtime/daemon) | Counter animates | frontend |
| **Anti-hang** | Finalize stuck daemon jobs on disconnect, startup, and 240s timeout reaper → clear "stopped responding" message instead of eternal spinner | Day-old stuck jobs cleared | `baf6b2e` |
| **Threading** | Reply in a thread implicitly targets that thread's agent (no `@` needed); reply lands in-thread | `reply-in-thread=true` | `baf6b2e` area |
| **Shared brain** | Inject an agent's recent cross-session (DM+channel) activity into its prompt for continuity | Digest present in dispatched job prompt | `f62b9c0` |
| **Yolo remote daemons** | Connection-command defaults `default`→`yolo` (`--permission-mode yolo --no-sandbox`) | flags in generated command | `baf6b2e` area |
| **Dead-connection cleanup** | Auto-prune (dedupe on register + 120s sweep) + manual X per offline row + DELETE endpoint | 14 stale rows → 2 live (coder+scout) | `7a70377` |
| **DM isolation** | 1:1 DMs are single-agent — only the direct agent responds; its `@`-mentions to others are ignored | `@scout` in a Coder DM → only Coder replied | `0593de4` |
| **Clear channel** | Per-session view cutoff (eject from view, keep history, "Show earlier" to restore) | typecheck clean | `828709e` |
| **Dropdown clipping** | Tightened channel `@`-mention dropdown + fixed home composer dropdown zero-padding heading clip | home dropdown verified clean | Netlify |

## Deploy state

- **Fly backend:** all server changes live (last: DM isolation `0593de4`), machine healthy in `fra`, WebSocket + agent dispatch working.
- **Netlify frontend:** last agent-authored deploy `index-CJ77aeOJ.js`. Subsequent frontend commits from worktree merges (agent-list icons, applet auto-focus, etc.) are committed but were not deployed by this session — deploy when ready.
- **Daemon package:** `@agensis/agensis-agent` unchanged — no rebuild/republish needed. Existing daemons must re-copy the connect command to pick up the yolo default.

## Open items

1. **Streaming (unverified end-to-end):** backend + UI are unblocked (metadata fix) and the daemon already runs `claude -p --output-format stream-json`, but live token-by-token rendering was not observed — only placeholder→final. Quick check: DM an agent a multi-sentence prompt and watch whether it types progressively. If it appears all at once, the daemon needs incremental-delta emission + a `0.0.6` republish.
2. **Rotate secrets:** the DB password and Anthropic API key were pasted in plaintext during setup — rotate them.
3. **Deploy pending frontend:** worktree-merged frontend work is committed but not on Netlify via this session.

## Notes

- Every Fly backend deploy restarts the machine and briefly drops daemon WebSocket connections (~30s reconnect). Daemon churn during the session was deploy-driven, not a bug.
- `workspace_members` / invites, Users window, and the connection cleanup all live and committed.
