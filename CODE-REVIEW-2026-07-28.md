# agensis — Full Code Review & Recommendations

## Context

Whole-repo code review requested 2026-07-28. Scope confirmed by Jason: **whole repo**
(server/ ~25K lines, netlify functions, shared core, frontend src/, visual-editor,
electron/desktop), reviewed through the three `code-review-*` skill lenses mandated by
the `code-review` orchestrator skill:

1. **Change size** — ≤800-line changes (≤500 complex), staging of oversized changes, oversized units.
2. **Model-context hygiene** — caps on everything injected into agent/model context, no silent truncation, fencing of untrusted data, cache-friendliness, one assembly convention.
3. **Testing** — runner-glob coverage, integration tests for agent logic, vacuous mocks, test-only production code, helper reuse, smoke coverage.

Recent history under review: backend extraction refactor (PR #23, `1f1eac9^..HEAD`,
48 files, +8,553/−4,751) + HEAD `0a089b0` visual-editor page selector (+1,482/−84).

Pre-flight verified against current code (NOT findings — stale memories cleared):
- `assertSafeOutboundUrl` SSRF guard IS on main (gateway, ai-chat, sandbox, link-preview paths).
- eslint glob widened to `shared/**/*.{cjs,mjs}`; `tests/lint-coverage.test.cjs` exists.

Method: three read-only review subagents (one per skill), findings returned with
file:line, consolidated below. Reviewers run on the inherited session model after
`Explore`/alias model resolution failed against the qwen3.8-max-preview proxy.

## Findings — Lens 1: Change size

Refactor wave (`1f1eac9^..HEAD`) spot-checked for smuggled behavior via
deleted-vs-added line membership: all 8 extraction commits 0–3 unmatched deleted
lines, each a comment/wiring line. **Production behavior in the wave is preserved.**

### Wave changesets

**1. P1 — HEAD commit ships three independent features + tests + examples in one 1,566-line change**
- `0a089b0` (+1,482/−84): `visual-editor/src/client.js` +476 (26 interleaved hunks), `tests/unit/visualEditorInteractions.test.ts` +479, `visual-editor/src/discover.cjs` +85, `visual-editor/src/server.cjs` +65, 5 example files +315, `visual-editor/README.md` +122
- Non-mechanical, complex UI logic — past both the 800 and 500 ceilings. Separable in the diff: page selector (`client.js:1582-1655` + `discover.cjs:38-110` + `server.cjs:678-730`), inline text editing (`client.js:2552-2710`), alignment guides (`client.js:3087-3226`, `3254-3346`). Smallest first stage: server-side page-discovery route + node tests (~200 lines, zero client entanglement), then one feature per commit. (Applies going forward, not retroactively.)

**2. P1 — ae9bd32 bundles seven unrelated route extractions and smuggles a test-coverage restoration**
- `ae9bd32` (+778/−626): 7 new route modules + edits to `tests/join-link.test.cjs:7-12`, `tests/cartesia-voices.test.cjs`, `tests/message-tool-steps.test.cjs`
- Mechanical (exempt from 800 cap) but seven independent blocks should be seven commits. The join-link test change is behavioral: the old slice had `end` before `start` so the checked block was empty — assertions passed vacuously and this commit silently restores coverage inside a refactor. That fix belongs in its own commit.

**3. P2 — Wave-4 extraction diffs run 1,000–2,100 changed lines each, inflated by source-text tests**
- `573c767` 2,103 changed (`server/agent-jobs.cjs` +1,071), `7a18cd4` 2,019 (`server/builtin-turn.cjs` +1,015), `d1c772b` 1,459, `6e4d5a6` 1,057, `7749888` 1,008
- Verified mechanical. Each re-anchors source-slicing tests (`tests/agent-job-progress.test.cjs:28-47`, `tests/builtin-tool-loop.test.cjs:46-56`, `tests/reply-cadence.test.cjs`) — the fly-lane source-slicing test pattern pushes pure moves past 800 lines and is what produced the vacuous assertion in finding 2. Advisory: pattern makes every future extraction diff larger and silently fragile.

**4. P2 — d1c772b / 573c767 include test-semantics edits inside refactor commits**
- `tests/agent-job-progress.test.cjs:28-47` (573c767): slicer bound changed from `indexOf('\n}\n')` to indent-matched close — old bound would have passed on a neighbor's code post-move. `tests/builtin-tool-loop.test.cjs:723-728` (7a18cd4): slices re-pointed at the new module.
- Both correct and documented, test-side only — but they change what the suite enforces and shipped under `refactor:` subjects.

### Oversized units future changes inherit

**5. P1 — server/index.cjs still 7,715 lines post-refactor, ~10 concerns**
- `ensureRuntimeSchema` `server/index.cjs:756-1763` (1,007 lines DDL), farm/flow stores `:1776-2049`, CursorBuddy `:2490-2754`, `buildInboxSql` `:3402-3569` (167-line fn), provider-call ops `:4467-4765`, `continueConversation` `:5057-5316` (259-line fn), Cartesia+inference relay `:5447-5788`, peer tickets `:5788-6004`, flow webhooks `:6373-6601`, `seedDefaultAgents` `:6601-6824` (223), `/backend/db/*` RPC `:7160-7443`
- First stage: `ensureRuntimeSchema` → `server/schema.cjs`. Pure SQL, one call site (`:6964`), zero shared mutable state — removes 13% of the file behavior-preserving.

**6. P1 — server/mcp.cjs buildTools() is a single 1,228-line function**
- `server/mcp.cjs:247-1474` (next decl `toolAllowedForIdentity` at 1475); file 1,742.
- First stage: split by identity/domain into per-group builders (the `tools.push(...)` blocks are already contiguous), `buildTools` becomes the concatenator.

**7. P1 — visual-editor/src/client.js: 3,892-line single IIFE, 162 functions**
- `visual-editor/src/client.js:1-3892` (boot at 3880-3892). No function >150 lines — the unit problem is the file; all three finding-1 features land in it.
- First stage: carve drag/drop + alignment-guide subsystem (`:3024-3892`, ~860 lines) into its own script sharing an explicit state object; zero-dependency browser script, so extraction is a concatenation boundary.

**8. P1 — netlify/functions/backend.mjs: 2,793-line mirror with triplicated helpers**
- 34 route branches; helpers duplicated from `server/index.cjs`: `slugHandle` (`backend.mjs:293` / `index.cjs:2245`), `hashAgentToken` (`:297` / `:2249`), `agentConnectionCommand` (`:422-449` / `:2869-2908`), `quoteIdent` (`:493` — also `shared/backend-core.cjs:497`, three copies)
- First stage: move duplicated pure helpers (~120 lines) into `shared/`, import from both backends — zero behavior change, shrinks drift surface.

**9. P1 — ChatWindowContent.tsx: 4,372 lines, ~2,180-line main component + 8 co-located components**
- Main `src/components/windows/ChatWindowContent.tsx:310-2490`, `ChatMessageBubble` `:2597-2884` (287), `ChannelSidePanel` `:2997-3254` (257), `GitChangesView` `:3254-3507` (253), `AgentProfileSidePanel` `:3507-3680` + helpers `:3680-3893`
- First stage: move `GitChangesView` + `AgentProfile*` family (`:3254-3893`, one call site each) out — ~640 lines, pure moves.

**10. P1 — App.tsx: 3,780 lines, 1,907-line AppContent + 778-line co-located scene**
- `AppContent` `src/App.tsx:630-2537`, `CanvasLayerScene` `:2537-3315` (778), `ReadOnlyChatWindowContent` `:3315-3391`, `InactiveChatWindow` `:3391-3530`
- First stage: extract `CanvasLayerScene` (single call site, own prop surface) — 778 lines, no logic change.

**11. P1 — AgentsWindowContent.tsx: 3,210 lines, four 350–760-line components in one file**
- Main `src/components/windows/AgentsWindowContent.tsx:247-1008` (761), `AgentForm` `:1100-1514` (414), `AgentDetailPane` `:1514-2032` (518), `AgentConnectDialog` `:2048-2402` (354), `OrbConfigForm` `:2420+`
- First stage: `AgentDetailPane` out (largest, rendered only from main's detail branch).

**12. P1 — TasksWindowContent.tsx: 2,135 lines, three swappable views inline**
- Main `src/components/windows/TasksWindowContent.tsx:195-580`, `TaskDetail` `:763-1196` (433), `TaskEditPanel` `:1240-1428`, `TaskKanban` `:1521-1709` (188), Gantt `:1709-2135` (~426)
- Views selected by pref (`TASK_VIEW_PREF` `:155`) — natural split; `TaskKanban` + Gantt out first (~615 lines).

**13. P1 — Sidebar.tsx main component ~707 lines inside a 2,010-line file**
- `src/components/layout/Sidebar.tsx:289-996` (main), helpers factored below at `:996-1056+`
- Split render body by rail section (DM rows, channel rows, agent rows).

**14. P1 — shared/backend-core.cjs: 1,790 lines mixing four concerns both backends import**
- Table allowlists/column maps `shared/backend-core.cjs:31-340`, auth token issue/verify `:406-497`, RBAC + `enforceDbOperationAccess` `:508-970`, activity logging `:971+`
- First stage: DB table-metadata block (31-340, pure data+fns) → `shared/db-allowlist.cjs` with backend-core re-exporting.

**15. P1 — server/huddles.cjs: 1,585 lines mixing pure domain logic, LiveKit glue, ~860-line route block**
- Pure domain `server/huddles.cjs:127-646`, SDK loader/token mint `:646-724`, `mountHuddleRoutes` `:724-1585`
- First stage: `mountHuddleRoutes` → `server/huddle-routes.cjs`, mirroring the wave's pattern.

**16. P1 — server/ai-chat-routes.cjs: one 213-line handler mixing three relay paths**
- `server/ai-chat-routes.cjs:42-255` (validation + gateway SSE relay + Anthropic relay + headers-sent error framing)
- Split into `relayGatewayChat()` / `relayAnthropicChat()`; route keeps auth + dispatch; SSE-error framing (240-255) to a shared helper.

**17. P2 — freshly extracted modules already exceed 800-line unit size**
- `server/agent-jobs.cjs` 1,071; `server/builtin-turn.cjs` 1,015 with `runAgentTurn` `:321-818` (497-line fn); `server/agent-connections.cjs` 773; `server/task-dispatch.cjs` 519
- Next split: `runAgentTurn`'s four lanes (MCP pull / external / builtin / daemon, `:321+`) into per-lane functions — `tests/builtin-tool-loop.test.cjs:721-728` already names the four branches as the seam.

**18. P2 — server/sandbox-skills.cjs: 1,422 lines mixing validation, prose, credentials, rendering**
- Normalizers `:220-417`, `BUNDLED_SANDBOX_SKILLS` prompt prose `:444-640` (196 lines pure content), credential resolution `:652-896`, call planning `:896-1117` (`planProviderCall` 935-1074, 139), fencing + rendering `:1139-1367+`
- Cleanest first extraction: the bundled-prompt data block (444-640).

**19. P2 — frontend norm: 25 src/ files over 500 lines**
- Beyond findings 9-13: `DrawingLayer.tsx` 1,759 (main `:67-1125`, ~1,058), `SettingsDialog.tsx` 1,717 (9 tab panels inline), `backendClient.ts` 1,120, `useChat.ts` 1,091, `CanvasObjectRenderer.tsx` 998, `FloatingWindowShell.tsx` 948, `useHuddleVoice.ts` 923, `agentMeshModel.ts` 861, `DocWindowContent.tsx` 818, `useWindows.ts` 788, `canvasApps.ts` 774, `AgentNetworkDiagram.tsx` 750, +8 more at 500-570.
- Size alone no longer signals risk here; split criterion = co-located independent components (findings 9-12 all have them).

## Findings — Lens 2: Model-context hygiene

Verified-OK (not findings): transcript bounded to 8 KiB with a MARK
(`server/index.cjs:3656`, `truncateContextEnd` marker `:3677`); `read_skill` body
fenced+marked at 8000 chars (`server/skill-content.cjs:348,364-394`); provider
output fenced+marked at 4000 chars (`server/sandbox-skills.cjs:1139-1174`); orb
payload fenced+marked at 8192 chars (`server/orbs.cjs:44,332-333,383-401`);
per-call fence nonces correctly excepted from cache rules; realtime placeholder
UPDATE rewrites only the agent's own in-flight row (filtered by `isAgentPlaceholder`
`index.cjs:4153,3732-3734`, captured once per turn) — rule 1 (no history rewrite)
satisfied.

**1. P0 — Browser `/backend/ai-chat` lane applies NO server-side bound to anything the client sends**
- `server/ai-chat-routes.cjs:45` destructures `messages, memory, documents, workspaceContext, agentContext` straight from `req.body`; `:48` → `normalizeAiChatMessages`; `:55` → `buildSystemPrompt`.
- `server/index.cjs:6205-6222` `normalizeAiChatMessages` only drops empties and splits `system` — no count cap, no per-message length cap.
- Frontend caps (`src/hooks/useWorkspaceContext.ts:76-172`) are bypassable by a direct POST; the server is the boundary and enforces nothing. Rule 3 violated — `chat.messages` alone is unbounded count × unbounded length.

**2. P0 — Sandbox-skill prompt block: per-field caps, NO aggregate cap; worst case ~45–60K tokens**
- `server/sandbox-skills.cjs:1310-1361` `renderSandboxSkillPrompt` loops all skills (cap 12, applied `:675`) emitting `renderSkillBlock` (`:1259-1300`) each.
- Per-skill worst case: instructions 4000 (`:206,382`) + code 6000 (`:213,363`) + 24 endpoints ×~480 (`:326-336`) + notes 8×300 (`:413`) + summary/baseUrl/caps ≈ 15–21 KB; ×12 ≈ 180–250 KB ≈ 45–60K tokens.
- The comment at `:202-204` explicitly names "the daemon lane has a 10 KiB complete-prompt ceiling" — this block alone can exceed it 5×, and it rides in the reused system-prompt prefix. Rules 3 & 4 violated.

**3. P0 — Linked-document context concatenates FULL document bodies with no cap, even in the honest client**
- `src/hooks/useChat.ts:494-496`: `linkedDocuments.map(d => '--- Document: ... ---\n' + d.content...)` with no per-doc or total cap (contrast the workspace snapshot's 600-char cap at `useWorkspaceContext.ts:88`).
- Sent as `documents` (`useChat.ts:534,627`) → injected raw into `<linked_documents>` at `server/index.cjs:6201`. One large note crosses >10K tokens (rules 4 & 5).

**4. P1 — Sandbox skill `instructions`/`code` truncated SILENTLY — contradicts the AGENTS.md "truncation IS marked" claim (true only for the separate `read_skill` path)**
- `server/sandbox-skills.cjs:382` instructions via `text()` `:220-223` (bare `.slice(0, max)`, no marker); `:363` code same.
- The code admits it at `:1378-1380`: "a guide that outgrows it loses its end mid-sentence with nothing in the output to say so." Agent-visible, every sandbox turn, unfenced (treated as trusted operator instructions). Compare the MARKED path `server/skill-content.cjs:366-372`.

**5. P1 — `list_thread_items`: `select *`, no LIMIT, no per-field cap; human-authored `response` returned unfenced**
- `server/mcp.cjs:971-978` (`select * from thread_items ... order by ...`, no `limit`); `content` uncapped at write: `create_thread_item` `:897,:907`, `update_thread_item` `:948`.
- Rule 3 violated; the human `response` field bypasses the fencing applied to other human-surfaced-to-agent content.

**6. P1 — Workspace memory facts: uncapped per-fact length at write, up to 500 returned, unfenced shared text**
- `server/mcp.cjs:1027-1031` `add_memory` inserts `fact` with no length cap; `get_workspace_memory` `:996` allows `limit` up to 500, returns full rows `:1007`. Aggregate = 500 × arbitrary chars (rule 3).

**7. P1 — `buildSystemPrompt` injects agent-row fields + every workspace-context block with no cap at the injection site**
- `server/index.cjs:6143` `Agent soul: ${agentContext.soul}`, `:6146` `agentContext.systemPrompt`, `:6149` `Instructions:\n${agentContext.instructions}` — all uncapped; browser lane receives `agentContext` from the client (`ai-chat-routes.cjs:45,51-54`).
- `:6186-6194` pushes `workspaceContext.memory/documents/tasks/canvas/agents/skills/commands/tools/webhooks` raw; only caps are client-side (§1).

**8. P1 — Scheduled and orb-dispatch prompts silently clipped at 4000 chars — agent-visible, no marker**
- `server/schedules-routes.cjs:112` + `:130` `String(prompt).slice(0, 4000)`; `server/index.cjs:2313` `body.prompt.slice(0, 4000)` (orb webhook). Silent, unlike the marked orb payload truncation at `server/orbs.cjs:332-333`.

**9. P2 — Three divergent prompt-assembly conventions; identical fragments tag-fenced in one lane, raw in another**
- Daemon: `buildDaemonPrompt` plain lines, `server/index.cjs:4765-4797` — `intentNote`/`VOICE_HUDDLE_NOTE`/`recentActivity` pushed RAW (`:4775,4776,4784-4790`).
- Builtin: `server/builtin-turn.cjs:343,350,362,477` wraps the SAME fragments in `<your_recent_activity>`/`<voice_huddle>`/`<channel_intent>`/`<tools>` tags.
- Browser: `buildSystemPrompt` uses a third vocabulary `<workspace_context>`/`<user_memory>`/`<linked_documents>` (`index.cjs:6196,6200,6201`). The two `buildDaemonPrompt` call sites (`builtin-turn.cjs:378,415,773`) share one function so they can't drift — but builtin-vs-daemon fencing of intent/voice/recent-activity diverges.

**10. P2 — No Anthropic `cache_control` breakpoint anywhere; volatile fragment inside the reused system prompt**
- Repo-wide grep finds no `cache_control`/`ephemeral`; only reference is the comment at `server/index.cjs:3706-3708`. Every turn re-sends full system prompt + ≤8 KiB transcript un-cached.
- `server/builtin-turn.cjs:343` appends volatile `recentActivity` (rebuilt from cross-session messages, `index.cjs:4189-4218`) into `agentContext.systemPrompt` — would defeat prefix caching if enabled (rule 2).

**11. P2 — Workspace-snapshot `memory` caps COUNT (40) but not per-fact length → still unbounded**
- `src/hooks/useWorkspaceContext.ts:78-80` `memoryFacts.slice(0, 40).map(f => '[' + f.category + '] ' + f.fact)` — `f.fact` uncapped (see §6); server injects raw (`index.cjs:6186`).

**12. P2 — Snapshot `skills`/`commands`/`tools` built from unbounded arrays (no count cap)**
- `src/hooks/useWorkspaceContext.ts:125-129` (every agent's skill names), `:131-137` (all CLIs + command libraries), `:139-150` (all packages + every agent's tools). Scale with workspace size, no ceiling, injected raw (`index.cjs:6191-6193`).

**13. P2 — `dispatch_agent`/`post_message` accept uncapped content at write, echo full row in tool result**
- `server/mcp.cjs:496` `content = requireString(args, 'content')` (no cap) → `insertAgentMessage` `:501`; result `:510` returns the whole message. Downstream bounded by the 8 KiB marked transcript cap (`index.cjs:3656,3674-3690`), but storage is unbounded and the result echo uncapped.

## Findings — Lens 3: Testing

Vacuous-mock audit (9 sampled): **no confirmed vacuous test.** Mocks return
facts/rows; the implementation under test makes the decision (e.g.
`tests/provider-proxy.test.cjs:253-285` asserts `stub.calls.length === 0`;
`tests/burst-job-liveness.test.cjs:25-43` fails if `finalizeStuckJob` writes
`'failed'` instead of `'error'`). The known vacuous-defect class is currently absent.

**1. P2 — "Invisible tests" fear is stale: no test file is invisible to all runners**
- `package.json:14` `tests/*.test.cjs` matches all 90+ top-level files (no nested `tests/**/*.test.cjs` exist — `find tests -mindepth 2` empty); `vitest.config.ts:8` matches all `.test.ts` under `tests/unit/`; `vitest.smoke.config.ts:11` matches both smoke files; `visual-editor/package.json` `node --test test/*.test.cjs` (4 files) was added to `ci` by HEAD `0a089b0` (`package.json:19`).
- `AGENTS.md:225` "invisible to both runners" claim is doc staleness only — fix the doc.

**2. P1 — Thread split/merge has unit coverage only; no integration test of split persistence or merge orchestration**
- Backend change was 5 lines of schema (`server/index.cjs:794-802`: `split_parent_id`/`split_at`/`deleted_at`); orchestration is client-side.
- Those columns appear in tests only as frontend fixtures: `tests/unit/threadMerge.test.ts:30-35` (4 tests incl. M7 clock-skew), `tests/unit/dmForkGroups.test.ts:23-44` (4 tests).
- No backend test writes `split_parent_id` on a split or proves a merge moves divergent messages into the parent and soft-deletes the fork. Soft-delete filtering covered separately (`tests/messagePagination.test.cjs:149`, `tests/send-to-channel.test.cjs:304`); `tests/thread-inbox.test.cjs:49` is a structural source-grep for `deleted_at is null` ×≥4.
- Per the skill: a feature changing agent conversation lineage needs an integration test.

**3. P1 — Smoke gate does not mount Documents or Schedules windows — both in the 2026-07-27 incident class**
- `src/types/index.ts:267` `FloatingWindowType` includes `'document'` + `'schedules'`; `tests/smoke/surfaces.smoke.ts:44-52` mounts 9 surfaces, neither of these.
- `src/components/windows/SchedulesWindow.tsx:182` renders "No schedules yet" empty state and filters at `:54` (`a.enabled !== false`) — exactly the empty-state-over-data/filter shape the gate exists to catch.
- `tests/smoke/trapStates.smoke.ts:115-171` probes Agents/Tasks/Activity/Inbox/Members only.

**4. P1 — GitHub Actions is a dead gate: both jobs finish with zero steps**
- `gh run view 30338099027 --json jobs` → both jobs `conclusion: failure`, `steps: 0`; recent runs complete in 5–12s. Workflow itself is well-formed and its header comment documents this exact signature (Actions minutes/spending-limit — forks drained the budget).
- Nothing server-side blocks a bad merge; local `npm run ci` is the only functioning gate.

**5. P2 — CI workflow, even with runners, would not run `smoke` or `test:visual-editor`**
- `.github/workflows/test.yml` jobs run typecheck/`npm test`/`test:unit`/lint — a strict subset of `package.json:19` `ci` (which adds `test:visual-editor` + `smoke`). If Actions is revived, the empty-state gate would silently not run.

**6. P2 — Test-only functions in production implementation files**
- `server/realtime.cjs:534` `registerTestWebsocketClient` (exported `:556`, zero prod callers); `server/agent-connections.cjs:723,728` `registerTestConnectedAgent`/`listTestConnectedAgents` (exported `:767-768`, header `:12-13` calls them "test seams"); test-only branch `server/index.cjs:316` (`AGENSIS_TEST === '1'` in `loadEnvFile`).
- Judged acceptable: `__test` exports of real production guards (`server/index.cjs:7515`, `server/mcp.cjs:1741`) — `assertSafeOutboundUrl`/`isBlockedAddress` are used at `server/ai-chat-routes.cjs:70`, `server/workspaces-routes.cjs:113,138`, `server/index.cjs:4686`.

**7. P2 — `withEnv` helper exists but 3+ test files re-roll env save/restore without pin checks**
- Provided: `tests/helpers/test-env.cjs:130` `withEnv` (asserts pin held both sides). Re-rolled: `tests/huddles.test.cjs:356-357`, `tests/netlify-parity.test.cjs:325-326`, `tests/workspace-vault.test.cjs:757-766`. 10 files `delete process.env` directly; only 3 import `withEnv`.

**8. P2 — No shared mock-DB factory; every mock-DB test re-rolls `makeDb`**
- `tests/helpers/test-env.cjs:162-169` exports env helpers only. Duplicated strict-mock `unsafe(sql, params)` with per-file SQL-prefix matching: `tests/provider-proxy.test.cjs:74-135`, `tests/backend-rbac.test.cjs:39-73`, `tests/realtime-revocation.test.cjs:17-31`, `tests/burst-job-liveness.test.cjs:25-39`, others.
- The known "`db.unsafe` block starting with `--` comment breaks strict mocks" defect is re-derivable per file instead of centralized.

**9. P2 — Two structural (non-vacuous) weaknesses**
- `tests/backend-rbac.test.cjs:68` hard-stubs the recursive-CTE ancestor walk to `[]` ("No fixture here has a parent" `:64-67`) — inherited-role GRANTING never exercised (denials are).
- `tests/agent-sandbox-schema.test.cjs:13-17` asserts DDL by regex over `server/index.cjs` source — cannot detect a column the live DB never got (the "Fly lag hides broken SQL" class). Same limit: `tests/thread-inbox.test.cjs:49-53`.

**Coverage-positive confirmations** (not findings): gateway SSRF, call_provider
proxy, wedged-DM reaping, DM/comment @mention dispatch, join links, skill sync,
PR #23 behavior-preservation guard (`tests/helpers/fly-lane.cjs:48-58` globs all
`*-routes.cjs` so source-scan tests follow moved code), and HEAD visual-editor
features (shipped unit + node tests in the same commit).

## Prioritized recommendations

Totals: **3 P0, 15 P1, 17 P2** across the three lenses (L = change-size,
C = context-hygiene, T = testing). The P0s are all context-hygiene and share
one root cause: the browser chat lane treats the client as the boundary.

### Stage 1 — P0: server-boundary caps (one focused PR, Fly-only deploy)

1. **Enforce in `normalizeAiChatMessages` + `buildSystemPrompt`, not the client**
   (C1 + C3 + C7, one boundary): message count cap, per-message length cap,
   aggregate body cap at `server/index.cjs:6205-6222`; cap-and-mark
   `documents` injection at `:6201` and `agentContext.*` at `:6143-6149`;
   cap each `workspaceContext.*` block at `:6186-6194`. Reject (413) or
   cap-with-mark over the ceiling — decide per field; marks must use the
   existing `truncateContextEnd` marker convention (`:3677`).
2. **Aggregate cap on `renderSandboxSkillPrompt`** (C2,
   `server/sandbox-skills.cjs:1310-1361`): a rendered-total ceiling under the
   daemon's documented 10 KiB prompt budget, applied after per-field caps,
   dropping lowest-priority skills with a mark. Pairs naturally with L18
   (extract the bundled-prompt data block `:444-640` first so the renderer is
   small and testable).
3. Tests: extend the ai-chat mock-DB tests to POST oversized bodies directly
   (bypassing the client) and assert rejection/marks. No UI change → no visual
   check needed; `node --check server/index.cjs` + `npm run ci`, then `fly deploy`.

### Stage 2 — P1: marked truncation + MCP tool caps (server-only)

4. **Kill silent truncation** (C4 + C8): make `text()` in
   `server/sandbox-skills.cjs:220-223` append the standard truncation mark
   (pattern at `server/skill-content.cjs:366-372`); replace the bare
   `.slice(0, 4000)` at `server/schedules-routes.cjs:112,130` and
   `server/index.cjs:2313` with the same marked helper.
5. **Cap the agent-facing MCP reads/writes** (C5 + C6 + C13):
   `list_thread_items` LIMIT + per-field cap (`server/mcp.cjs:971-978`), write
   caps at `:897,:907,:948`; `add_memory` per-fact length cap + lower the 500
   read limit (`:1027-1031`, `:996`); fence human-authored `response` text;
   `dispatch_agent`/`post_message` write caps (`:496`).
6. Client snapshot caps as defense-in-depth (C11 + C12,
   `src/hooks/useWorkspaceContext.ts:78-80,125-150`): per-fact length cap,
   count caps on skills/commands/tools.

### Stage 3 — P1: test coverage gaps

7. **Smoke-mount Documents + Schedules** (T3): add to
   `tests/smoke/surfaces.smoke.ts:44-52` and add trap-state cases to
   `tests/smoke/trapStates.smoke.ts` (Schedules has the exact filter+empty-state
   shape at `SchedulesWindow.tsx:54,182`).
8. **Thread split/merge integration test** (T2): backend test that persists a
   split (`split_parent_id`/`split_at`), then a merge that moves divergent
   messages to the parent and soft-deletes the fork — currently only frontend
   unit fixtures exist.
9. **CI hygiene** (T5 + T1 + T4): add `smoke` + `test:visual-editor` steps to
   `.github/workflows/test.yml` so a revived Actions runs the full gate; fix the
   stale `AGENTS.md:225` "invisible to both runners" claim (and test counts).
   Restoring Actions minutes is web-UI only — Jason-only, cannot be fixed in-repo.

### Stage 4 — P1: structural extractions (each its OWN behavior-preserving commit)

Order by safety/payoff; the wave proved this pattern works and
`tests/helpers/fly-lane.cjs:48-58` + `netlify-parity` tests guard it:

10. L5 `ensureRuntimeSchema` (`server/index.cjs:756-1763`) → `server/schema.cjs`
    — pure SQL, one call site, −13% of the file. Land first.
11. L14 `shared/backend-core.cjs:31-340` table-metadata block →
    `shared/db-allowlist.cjs` with re-export.
12. L8 triplicated helpers (`slugHandle`, `hashAgentToken`,
    `agentConnectionCommand`, `quoteIdent`) → `shared/`, imported by both
    backends — this is also a drift-correctness fix, not just size.
13. L15 `mountHuddleRoutes` → `server/huddle-routes.cjs` (mirrors the wave);
    L16 decompose the ai-chat handler into `relayGatewayChat()`/
    `relayAnthropicChat()` — do AFTER Stage 1 lands so the caps move with it.
14. L6 `buildTools()` split into per-domain builders (`server/mcp.cjs:247-1474`).
15. Frontend pure moves: L9 `GitChangesView` + `AgentProfile*` out of
    `ChatWindowContent.tsx` (~640 lines); L10 `CanvasLayerScene` out of
    `App.tsx` (778); L11 `AgentDetailPane` out of `AgentsWindowContent.tsx`;
    L12 `TaskKanban` + Gantt out of `TasksWindowContent.tsx`; L13 Sidebar rail
    sections. Each component has one call site — zero logic change.
16. L7 visual-editor drag/alignment subsystem (`client.js:3024-3892`) into its
    own script with an explicit shared state object.

**Process rule going forward** (from L1/L2/L4): non-mechanical commits ≤800
lines, one feature each; test-semantics changes and coverage restorations get
their own commits, never ride inside `refactor:` subjects. (The wave itself was
verified behavior-preserving — no retroactive action.)

### Stage 5 — P2, opportunistic

- C9 unify the three prompt-assembly vocabularies/fencing (daemon vs builtin vs
  browser); C10 add `cache_control` breakpoints + move volatile `recentActivity`
  OUT of the system-prompt prefix (cost win); L17 split `runAgentTurn`'s four
  lanes (seam already named by `tests/builtin-tool-loop.test.cjs:721-728`);
  L18/L19 as noted; L3 retire the source-slicing test pattern in favor of
  behavioral tests.
- T7 adopt `withEnv` in the 3 re-rolling files; T8 centralize the strict mock-DB
  factory in `tests/helpers/`; T9 add a parent-chain fixture to
  `tests/backend-rbac.test.cjs` so inherited-role GRANTING is exercised;
  T6 leave the documented test seams (judged acceptable).

## Cross-cutting notes

- **No live security finding survived verification.** The SSRF guard, vault
  write-only posture, join-link contract, and provider-call proxy all checked
  out with real (non-vacuous) tests. Prior memory on those is stale — cleared.
- **The refactor wave was clean.** Behavior-preservation verified by
  line-membership diffing; the P1s on it are commit-hygiene (bundling), not
  correctness.
- **Biggest systemic risk**: the browser chat lane's client-trusted context
  (Stage 1) — every P0 traces to it.
- **Second systemic risk**: the dead CI gate (T4) — until minutes are restored,
  every merge is gated only by whoever remembers `npm run ci` locally.

## Verification

After fixes land, per AGENTS.md gate (do NOT trust GitHub Actions — zero-step runs):

```bash
npm run ci                                    # typecheck + both suites + smoke + lint
node --check server/index.cjs                 # server touched
node --check netlify/functions/backend.mjs    # netlify touched
npm run build                                 # frontend touched
```

Plus visual verification of any UI surface touched (smoke gate cannot see everything;
green tests ≠ the app renders — 2026-07-27 empty-state incident).
Deploy order when shipping fixes: Fly before Netlify.
