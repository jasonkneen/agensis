# Code Review: agensis

**Date**: 2026-06-29  
**Branch**: main (up to date, clean working tree)  
**Scope**: Final merged code review using `code-review.md`, prior `grok-review.md` cross-checks, and the focused Activity/message logging review. Architecture, security, correctness, React/TS quality, UI components, backend/realtime, testing, build hygiene, maintainability, and risks.

## Current Health Snapshot (verified at review time)

- `npm run typecheck`: **PASS** (clean)
- `npm test`: **16/16 PASS** (backend-auth.test.cjs)
- `npm run lint`: **1 error**, 23 warnings  
  - Error: `_onUpdateAgent` unused in `ChatWindowContent.tsx:1754`
  - Warnings: react-refresh/only-export-components (many ui/ files), exhaustive-deps in DocWindowContent/FloatingWindowShell/CanvasObjectRenderer, unused eslint-disable in server
- Build artifacts (`dist/`, `release/`, `landing/node_modules/`) **correctly untracked** (per .gitignore and `git ls-files`)
- No console spam in src TS/TSX (strong hygiene)
- ~11 `as unknown as` casts, 19+ innerHTML sites (concentrated in risky areas)

## Scores (Synthesized from Parallel Agents)

| Area                    | Score    | Source Agent                  |
|-------------------------|----------|-------------------------------|
| Overall code health     | 65/100   | pr-review-toolkit:code-reviewer |
| Architecture            | 5/10     | Architect                     |
| Backend / Realtime      | 6.5/10   | general-purpose               |
| UI / Component System   | 7.2/10   | code-review-expert            |
| Security posture        | ~4/10    | Multiple agents + direct      |

## Executive Summary

agensis is a realtime collaborative workspace (chat + documents + memory + tasks + shared canvas + AI agents + webhooks) built with React 19 + TypeScript + Vite + custom Neon Postgres backend + WebSockets + Electron + PWA.

**Strengths**:
- Thoughtful product model (workspace-first, layers, private floating windows, shared canvas objects, agent protocol).
- Sophisticated RBAC + agent system (builtin + external daemon).
- Custom "Supabase-like" client works reasonably.
- Modern UI system with real production usage.
- Offline resilience and PWA support.
- Low console/TODO debt.
- Strict TypeScript + clean typecheck.

**Core Problems** (still largely present from prior grok-review.md):
- **Security surface**: Heavy unsafe innerHTML + full self-contained HTML/JS applets with postMessage bridge.
- **Architecture debt**: Massive monolith in `App.tsx`, duplicated backend logic (server vs netlify), global realtime fanout, module-level mutable state.
- **Activity correctness**: New chat/message activity logging is useful, but the Netlify path can record placeholder agent messages and message activity inserts are not idempotent.
- **Maintainability**: Very long files, duplication, type casts, per-hook realtime subscriptions, inconsistent formatting.
- **Production readiness gaps**: No rate limiting on AI, runtime schema mutations, tokens in localStorage + query strings, minimal tests.
- **Hygiene**: Dual lockfiles, React version skew (root vs landing), dead UI code, lint issues.

The product has ambitious features and works for its current scope, but the implementation carries significant technical debt that will slow iteration and increase risk.

## Architecture Breakdown

**High-level flow**:
```
Clients (React/Vite/PWA + Electron)
  → backendClient (QueryBuilder + RealtimeManager + LocalChannel)
  → server/index.cjs (Express + postgres + WS)  [primary]
  → (or netlify/functions/backend.mjs — partial duplicate)
  → Neon Postgres
  → agent/agensis-cli (separate npm package, WS daemon)
```

**Domain model** (strong): `Workspace` as root → canvas layers/objects/groups/applets + private `FloatingWindow`s + `WorkspaceAgent` + webhooks + jobs + activity.

**Strengths**:
- Clear separation of "shared content" (canvas, docs, memory) vs "local UI" (floating windows, presence views).
- Agent daemon is a proper standalone package.
- Applet contract enables interesting canvas extensions.

**Weaknesses** (detailed):
- No workspace sharding for realtime (global `websocketClients` Set in server/index.cjs:67).
- Thick client emulation in every hook.
- Layers and most window state are client-only (localStorage).
- Heavy coupling: hooks mix fetch + realtime + optimistic updates + domain logic.
- Duplication between `server/index.cjs` (~3123 LOC) and `netlify/functions/backend.mjs`.
- Monolithic backend (131 functions) and frontend (`App.tsx` ~2247 LOC).

**Recommendations**:
- Partition realtime or adopt external provider (rooms/adapter).
- Extract shared backend core.
- Make layers + private window state durable.
- Add clear module boundaries.

**Architecture Score: 5/10** — Fast to build interesting features; fragile at scale.

## Security Findings

**Critical**:
- **Arbitrary code / XSS via applets and documents**:
  - `src/lib/canvasApps.ts:273,281,299,307` — `innerHTML` inside generated full HTML/JS applets (only weak escaping on a few strings).
  - `src/components/windows/DocWindowContent.tsx` (multiple): `innerHTML =`, `renderGenerativeUiSpec`, autosave from `contentRef.current.innerHTML`, `stripHtml` via temp div (lines ~132,134,158,328,348,357,397,439,463,478,483,495,524).
  - `src/components/editor/DocumentVersionHistory.tsx:32` — same pattern.
  - Applet runtime: `<iframe sandbox="allow-..." srcDoc={full HTML}>` + postMessage contract for tasks/agents/state (CanvasObjectRenderer.tsx).
- Tokens only in localStorage; passed in WS query string (`backendClient.ts:129-141`).
- No rate limiting or cost controls on AI endpoints (`/backend/ai-chat`, agent dispatch).
- Runtime `ensureRuntimeSchema()` ALTER TABLE on every startup (server/index.cjs:464+).
- Agent connect tokens returned in plaintext; post-connect trust is socket-based only.

**High**:
- Webhook trigger path unauthenticated (token only).
- Inconsistent use of existing `escapeHtml`.
- In-memory `connectedAgents` (lost on restart).

**Positives**:
- Strong intent on workspace RBAC (server/index.cjs:244-277, resolveOperationWorkspace, enforce checks).
- Hashed agent tokens + DB binding.
- Electron uses `sandbox: true`, `contextIsolation: true`, `nodeIntegration: false`.
- Capability-gated AI access.

**Security Posture: ~4/10** — Treat generated applets and document content as untrusted. Add proper sanitization and stronger sandboxing immediately.

## Backend + Realtime Findings

**Strengths** (from dedicated agent review):
- Excellent RBAC design with table-specific capabilities.
- Sophisticated agent protocol (jobs, deltas, heartbeats, conversation orchestration with locks).
- Client abstraction successfully hides details from most hooks.
- Offline queue + cached fetch.
- Parameterized queries + table allowlist.

**Issues**:
- Global fanout loop on every change (`notifyDbSubscribers` + `relayBroadcast`).
- Query-string auth + connect-time-only agent auth.
- Runtime schema evolution (fragile for concurrent deploys).
- Optimistic updates + realtime races in useChat, useCanvasObjects, etc.
- No throttling on AI paths.
- Heavy duplication with Netlify function; this has already caused behavioral drift.
- **Activity logging drift**: `server/index.cjs:2197-2199` skips `"Thinking 0s"` agent placeholders and logs finalized daemon replies on update (`server/index.cjs:1621-1624`), but `netlify/functions/backend.mjs:782-784` logs every message insert. If a daemon placeholder reaches the Netlify path, Activity can show a fake/empty assistant reply and miss the final response.
- **Activity logging is not idempotent**: `server/index.cjs:2217-2221` and `netlify/functions/backend.mjs:747-749` insert `activity_events` rows without a uniqueness guard on `(event_type, entity_type, entity_id)` or equivalent. Retried daemon finalization can duplicate Activity feed entries for the same `messages.id`.
- Error handling is mostly consistent but many silent catches in client.

**Maturity: 6.5/10** — Feature-rich and clever, but needs partitioning, rate limits, idempotent activity/event writes, and removal of runtime migrations for production.

## Frontend State & Core Findings

**App.tsx** is the central problem (~2247 LOC): owns auth, 15+ domain hooks, window management, presence, AI extraction, layer switching, context counts, etc.

- Massive prop drilling and derived state.
- `useWindows.ts:4` — `let nextZIndex = 100` (module mutable state).
- `useCanvasObjects.ts` — `nextZRef` + timer maps.
- Realtime duplication: nearly every hook independently subscribes to channels + `db_changes`.
- Frequent `as unknown as` casts to satisfy the loose backend client.
- Windows are purely local (lost on refresh).
- No virtualization on canvas, chat, or document lists.

**Recommendations**:
- Extract `useWindowManager`, presence manager, and workspace context into dedicated hooks/contexts.
- Remove module-level counters.
- Centralize realtime subscriptions.
- Consider a lightweight state solution or better context slicing.

## UI Component System

High-quality shadcn-inspired system (~60 files) with strong data-slot discipline, cva, composable families (Attachment, Item, Field, Bubble/Message, InputGroup, MessageScroller).

**Critical**:
- Broken className forwarding in cva components:
  - `button.tsx:61`, `item.tsx:72`, `marker.tsx:36` — `cn(variants({ ... , className }))` loses the className.

**High**:
- Exact duplication: `bubble.tsx` `BubbleGroup` === `message.tsx` `MessageGroup`.
- Dead code: `direction.tsx` (unused), large `ui/sidebar.tsx` (never imported).
- 20+ unnecessary "use client" directives.
- `select` vs `native-select` confusion.
- FieldTitle data-slot collision with FieldLabel.

**Medium**:
- Thin wrappers and showcase-only bloat.
- Mixed primitive libraries (radix + @base-ui + @shadcn/react).
- Missing root providers (TooltipProvider, Toaster) in main app path.
- Complex Tailwind v4 selectors and magic z-indices.

**Positives**:
- Real usage in production UI (chat, agents, settings, files).
- Good accessibility primitives and composability where it matters.
- Consistent design tokens.

**Score: 7.2/10** — Fix forwarding + dedupe immediately.

## Code Quality & Hygiene

**Positives**:
- Strict TS config + clean typecheck.
- Very few `console.*` or TODOs in src.
- Good .gitignore.
- Existing tests pass.

**Issues**:
- Long files everywhere (App, ChatWindowContent 2760 LOC, DrawingLayer 1603, server 3123, etc.).
- ~11 `as unknown as` casts across hooks and App.
- Minimal test coverage (only backend auth with heavy mocks).
- Dual lockfiles (bun + npm) + React 19 vs 18 in landing/.
- Formatting drift (semicolons vs no-semicolons).
- Current lint error + many warnings.

**Overall Code Health: 65/100**

## File Hotspots (priority order)

1. `src/App.tsx` — monolith, prop drilling, casts
2. `server/index.cjs` — fanout, runtime schema, AI/agent logic, duplication source
3. `src/lib/canvasApps.ts` + `src/components/canvas/CanvasObjectRenderer.tsx` — applets
4. `src/components/windows/DocWindowContent.tsx` — innerHTML
5. `src/hooks/useWindows.ts:4` + useCanvasObjects + useChat — module state + realtime
6. `src/components/ui/button.tsx`, `item.tsx`, `bubble.tsx`/`message.tsx`, `direction.tsx`
7. `src/lib/backendClient.ts` — WS token handling
8. `netlify/functions/backend.mjs` — logic duplication; message Activity logging drift vs local server
9. `server/index.cjs:1621-1624,2217-2221` + `netlify/functions/backend.mjs:747-749,782-784` — non-idempotent/placeholder-prone message Activity logging
10. `ChatWindowContent.tsx:1754` (current lint) + DocWindowContent exhaustive-deps

## Prioritized Recommendations

### Immediate (do first)
1. Fix the lint error in `ChatWindowContent.tsx`. Run `npm run lint -- --fix` and address key exhaustive-deps warnings.
2. Add centralized sanitization (DOMPurify or strict allowlist) for **all** document innerHTML paths, generative UI, and canvas applet output.
3. Fix className forwarding bug in button/item/marker (change to `cn(variants({...}), className)`).
4. Fix message Activity correctness:
   - apply the same agent-placeholder guard in Netlify that exists in the local server;
   - log finalized daemon replies on the Netlify UPDATE/finalization path if that deployment supports daemon placeholders;
   - make message activity insertion idempotent with a partial unique index or `ON CONFLICT DO NOTHING`/upsert keyed by message id.
5. Remove dead `direction.tsx`. Decide on unused `ui/sidebar.tsx`.
6. Strip all unnecessary "use client" directives.

### High Priority
7. Eliminate module-level `nextZIndex` in `useWindows.ts`.
8. Extract substantial logic from `App.tsx` (window orchestration, presence, context building).
9. Add server-side rate limiting + logging on AI routes and agent dispatch.
10. Stop running `ensureRuntimeSchema()` ALTERs in production paths. Use proper migrations.

### Medium / Structural
11. Centralize realtime subscription management.
12. Remove duplication between `server/index.cjs` and Netlify function (extract shared core for message/activity handling, auth, and DB notifications).
13. Reduce `as unknown as` casts — tighten types or add validation at backendClient boundary.
14. Add meaningful tests (canvas CRUD, optimistic races, RBAC denies, sanitized doc roundtrips, agent flows, Activity feed placeholder/idempotency cases).
15. Unify package manager locks and React/Tailwind versions (or clearly separate landing).
16. Update README.md tech stack section. Audit unused deps (e.g. next-themes).

### Longer Term
- Partition realtime fanout or adopt external solution.
- Make layers and private windows durable.
- Formalize applet contract (versioning, sandboxing, allowlist).
- Add observability on hot paths (fanout volume, agent latency, AI usage).
- Set component size budgets and split rules.

## Verification Steps (after any changes)

1. `npm run typecheck && npm run lint && npm test`
2. Full manual flows in dev:
   - Multi-user canvas + private windows + presence + cursors
   - Chat + AI TASK extraction + workspace context + direct agent messages
   - Activity feed message entries, including daemon placeholder finalization and duplicate/retried job-result handling
   - Document editing + generative UI + version restore + AI assist
   - Applet creation + interaction + state/task/agent bridge
   - Agent creation + webhook + daemon simulation
   - Offline queue + sync
   - Layers, sharing, roles, secrets
3. `npm run build && npm run preview`
4. Electron dev and packaged run
5. Network tab + server logs (no secret leaks, reasonable traffic)
6. Negative tests (bad tokens, cross-workspace attempts, malicious applet content)
7. Re-run focused sections of this review on the diff

## Open Questions

- How important is keeping the contenteditable + generative innerHTML document model vs moving to structured blocks?
- Applet security model: treat generated code as fully untrusted (stronger isolation) or workspace-trusted?
- Long-term plan for the custom realtime client + backendClient (keep the facade or migrate)?
- Primary supported deployment story?

---

**Review generated with parallel agents** (Architect, code-review-expert, pr-review-toolkit:code-reviewer, general-purpose backend specialist), direct file inspection, verification commands, and the focused Activity/message logging review.

This report is self-contained. Previous `grok-review.md` findings and the later focused review were cross-referenced; duplicate items were consolidated into the prioritized sections above.

**Next steps**: Prioritize the security + Activity correctness + duplication + lint items. Small, targeted fixes will have high impact.
