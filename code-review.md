# Code Review: agensis (final)

**Date**: 2026-06-29
**Branch**: `main` (commit `6bbd588`, clean working tree aside from this file)
**Scope**: Full codebase review — architecture, security, correctness, React/TS quality, UI/shadcn, backend/realtime, testing, build hygiene, deployment readiness. Cross-checked against the prior `grok-review.md` (2026-06-28), the post-grok refactor commits (`3e765c9`, `ff242fb`, `ce416e4`) that cleaned up dead code, tightened realtime typings, and moved password hashing to async scrypt — and the live main-branch checkout.

## Verification (run at review time)

| Check | Result |
|---|---|
| `npm run typecheck` | **PASS** (strict mode) |
| `npm run lint` | **1 error, 23 warnings** — `ChatWindowContent.tsx:1754` `_onUpdateAgent` unused is the only error; warnings are mostly `react-refresh/only-export-components` across `ui/` and a handful of `exhaustive-deps` in DocWindowContent, FloatingWindowShell, CanvasObjectRenderer |
| `npm test` | **16/16 PASS** (`backend-auth.test.cjs`) |
| `rg "innerHTML\|dangerouslySetInnerHTML\|insertAdjacentHTML\|outerHTML" src` | 18 sites — see Security |
| `rg "as unknown as" src` | 12 casts |
| `rg "console\.(log\|warn\|error\|debug\|info)" src` | 2 sites, both intentional offline-handler noise |
| Build artifacts tracked? | No — `dist/`, `release/`, `landing/node_modules/` correctly untracked |

## Composite Scores

| Area | Score |
|---|---|
| Overall code health | **65 / 100** |
| Architecture | **5 / 10** |
| Backend / Realtime | **5.5 / 10** |
| UI / Component System | **7.2 / 10** |
| Security posture | **~3 / 10** until Netlify parity is fixed |

## Executive Summary

agensis is a realtime collaborative workspace (chat, documents, memory, tasks, shared canvas, AI agents, agent webhooks, sharing) built on React 19 + TypeScript + Vite + a custom Neon/Express/WebSocket backend, packaged as both a PWA and an Electron desktop app. The product model and security *intent* are strong; the *deployment* posture is not, because the serverless Netlify function (`netlify/functions/backend.mjs`) ships without the auth/RBAC contract the primary Express backend enforces.

**What's working**
- Workspace-first domain model with clear separation between shared content (canvas, docs, memory) and local UI (floating windows, presence).
- Sophisticated RBAC, agent daemon protocol with hashed connect tokens, capability-gated AI access.
- Custom Supabase-like `backendClient` facade is usable; hooks look Supabase-shaped.
- Strict TypeScript passes; modern shadcn-inspired UI with real production usage; offline queue + PWA; minimal `console.*`/TODO debt.
- Refactor commits of 2026-06-29 already removed several pieces of dead code flagged by `grok-review.md` (unused `onNewChat`, unused sync helper, looser realtime types).

**What's blocking**
- **Netlify backend parity**: the serverless function is unauthenticated for generic DB, settings, AI, and agent-management routes — a single curl call can list/update workspace secrets, hit `/backend/ai-chat`, or mint agent connection tokens. Either fix or remove.
- **HTML sanitization surface**: `DocWindowContent.tsx` writes `innerHTML` from autosaved document content across ~12 sites; `canvasApps.ts` injects full HTML+JS applets with a postMessage bridge; `DocumentVersionHistory.tsx` restores the same flow. Pasted/clipboard content enters the contenteditable unsanitized.
- **App.tsx monolith** (~2247 LOC): owns 20+ domain hooks, window orchestration, presence, dialog state, AI extraction, layer switching. Massive prop drilling into `CanvasLayerScene`-style children.
- **Module-level mutable state** (`useWindows.ts:4` `nextZIndex = 100`; `useCanvasObjects` `nextZRef` + timer maps) is non-SSR-safe and untestable.
- **Non-idempotent Activity logging** for chat messages — retried daemon finalizations sync duplicate rows.
- **No rate limiting** on AI endpoints or agent dispatch; runtime schema ALTERs on every backend startup; tokens in `localStorage` and in the websocket query string.
- **UI dep overlap**: `@base-ui/react` ^1.6.0, `radix-ui` ^1.6.0, `@shadcn/react` ^0.1.0, and `shadcn` ^4.12.0 are all installed — four overlapping UI library ecosystems.
- **Dual lockfiles** (`bun.lock` + `package-lock.json`); React 19 in root, React 18 in `landing/`; minimal test coverage (one suite).

The product is feature-rich and the local/Electron path is meaningfully safer than the serverless path. The Netlify function is not safe to expose publicly in its current form.

---

## Critical Findings (block production exposure)

### C1. `netlify/functions/backend.mjs` is unauthenticated
The Netlify function routes several handlers without the `requireAuth` guard and table-policy enforcement that `server/index.cjs` applies.

| Route area | File:line | What is missing |
|---|---|---|
| Generic DB | `netlify/functions/backend.mjs:757-817` | No workspace RBAC check on select/insert/update/delete; `update`/`delete` accept empty filters, so a request can rewrite or wipe an entire allowed table |
| DB dispatch | `netlify/functions/backend.mjs:976-978` | `/backend/db/*` is forwarded to `handleDb` with no `Authorization` validation |
| Settings / secrets | `netlify/functions/backend.mjs:979-1000` | Read/update of managed secrets, including workspace-scoped `ANTHROPIC_API_KEY`, no auth |
| AI chat | `netlify/functions/backend.mjs:1002-1003` | `/backend/ai-chat` callable without a token |
| Agent webhooks / connect | `netlify/functions/backend.mjs:604-674` | Webhook creation and agent connection-command / token minting without auth |

Local Express has `requireAuth`, `enforceDbOperationAccess`, role checks, and unfiltered-delete guards. The Netlify path needs the same contract or needs to be deleted in favor of the Express deployment.

### C2. HTML sanitization gaps

* **`src/lib/canvasApps.ts:273, 281, 299, 307`** — generated full HTML/JS applets with innerHTML writes. Although applets are iframe-sandboxed, the postMessage bridge is reachable from sandboxed scripts, so all bridge messages must be treated as untrusted.
* **`src/components/windows/DocWindowContent.tsx`** — `innerHTML =` writes from autosave + `stripHtml` via temp div at lines 132, 134, 158, 328, 348, 357, 397, 439, 463, 478, 483, 495, 524. Persisted document content is round-tripped through `innerHTML` with insufficient escaping.
* **`src/components/editor/DocumentVersionHistory.tsx:32`** — same round-trip.
* **Pasted content** into the contenteditable editor is not sanitized at paste time.
* **`src/components/chat/MarkdownContent.tsx` + `ChatWindowContent.tsx`** — markdown rendering allows raw HTML in source; AI streaming chunks accumulate unsafely before message finalization.

There is a `stripHtml` / `escapeHtml` helper but it is not applied uniformly.

### C3. Message Activity logging is non-idempotent
* **`server/index.cjs:2197-2199`** skips `"Thinking 0s"` agent placeholders; **`server/index.cjs:1621-1624`** logs finalized daemon replies on update.
* **`netlify/functions/backend.mjs:782-784`** logs every message insert (no placeholder guard), and **`server/index.cjs:2217-2221`** + **`netlify/functions/backend.mjs:747-749`** insert `activity_events` rows without a uniqueness guard on `(event_type, entity_type, entity_id)` or a `messages.id` key.

Result: a retried daemon finalization can duplicate the Activity feed entry for the same message; a Netlify-deployed daemon placeholder can register as a fake/empty assistant reply.

---

## High Priority

### H1. App.tsx monolith and prop drilling
`src/App.tsx` (~2247 LOC) owns 20+ domain hooks, window orchestration, presence, dialog state, AI extraction, layer switching, context counts. Children receive 40-50 props via `CanvasLayerScene`-style drilling; ChatWindowContent alone is 2760 LOC. There are 12 `as unknown as` casts across hooks and App. Frequent useEffect recomputation of derived state (`workspacePresenceUsers`, `contextCounts`).

Suggested decomposition (do this in three small PRs to keep review tractable):
1. **`useWindowManager` hook + `<WindowManagerProvider>`** — owns `FloatingWindow` lifecycle, restore-bounds, z-order, minimize/maximize/focus. Eliminates `let nextZIndex = 100` in `useWindows.ts:4` and the module-level mutable state in `useCanvasObjects` (`nextZRef`, timer maps).
2. **`<PresenceProvider>` + `<WorkspaceKnowledgeProvider>`** — extracts `workspacePresenceUsers`, `contextCounts`, the itemPresence vs useWorkspaceContext overlap.
3. **`<ChatOrchestrationProvider>`** — AI extraction, message dispatch, agent-thread bridging. Removes the AI-side prop drilling into `ChatWindowContent`.

### H2. Realtime subscription duplication
Nearly every domain hook (`useChat`, `useDocuments`, `useCanvasObjects`, `useMemory`, `useFiles`, `useTasks`, `useActivity`, `useAgents`, `useAgentWebhooks`, `useAgentConnections`, `useSharing`, `useItemPresence`, `useMultiplayerCursors`) opens its own `LocalChannel`, db_changes subscription, and broadcast listener. Optimistic updates + server acknowledge + realtime broadcast can fire three times for the same write; current dedupe is by `id` only, not by `(id, version)` or `(id, updated_at)`. The `version` column on most tables is unused — either wire it into optimistic concurrency or drop the column.

Centralize: introduce a typed `RealtimeManager` singleton that owns `(workspace_id, table) → Set<Listener>` and yields `useTableSubscription(table, callback)` hooks. Pair with a stable row-version check.

### H3. Tokens and authentication
* `backendClient.ts:129-141` puts the auth token into the websocket query string — stored in browser history and any proxy/nginx logs.
* `AUTH_STORAGE_KEY` lives in `localStorage` with no `HttpOnly` fallback and no server-side session revocation beyond signout.
* Agent connect tokens are returned plaintext when minted; ensure they are one-time-only, rotatable, and never logged.
* Webhook trigger path is token-only — acceptable but needs rate limiting and revocation ergonomics.

### H4. No rate limiting / cost controls
`/backend/ai-chat`, the agent dispatch path, and webhook trigger handlers have no per-user or per-workspace rate limit and no token budget. Combined with C1, this is a free-tier abuse vector once the Netlify function is exposed.

### H5. UI dependency overlap
`package.json` installs four overlapping UI library ecosystems at once:
* `@base-ui/react` ^1.6.0
* `radix-ui` ^1.6.0
* `@shadcn/react` ^0.1.0
* `shadcn` ^4.12.0

Plus the locally-bundled `src/components/ui/*` (60 files). The shadcn CLI is only used to add components; nothing in the repo is generated from `@shadcn/react`. Pick two (recommend **Radix for primitives + the local shadcn-style components**) and remove the others. This reduces bundle weight and resolves the `select` vs `native-select` confusion that ships today.

### H6. Runtime schema mutations in production path
`server/index.cjs:464+` runs `ensureRuntimeSchema()` (broad `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` + constraint mangling) on every startup. Two problems:
* Fragile under concurrent deploys — two cold-starts racing can dead-lock or apply inconsistent state.
* Hides migration drift between the canonical `database/neon-schema.sql` and the runtime.

Replace with a proper migration runner (e.g. `node-pg-migrate`, `drizzle-kit`) and gate runtime fallback behind an explicit `--allow-runtime-migrate` flag.

---

## Medium Priority

### M1. Long files and duplication
* `src/App.tsx` (2247), `src/components/windows/ChatWindowContent.tsx` (2760), `src/components/canvas/DrawingLayer.tsx` (1603), `src/components/layout/Sidebar.tsx` (1211), `src/components/windows/AgentsWindowContent.tsx` (981), `server/index.cjs` (3123).
* Duplicate backend surface in `server/index.cjs` (3123 LOC, 131 functions) and `netlify/functions/backend.mjs` (~1100 LOC). Already drifted in security behavior (C1) and Activity semantics (C3).
* `src/components/ui/bubble.tsx` and `src/components/ui/message.tsx` have identical `BubbleGroup`/`MessageGroup` implementations. Consolidate.
* `src/lib/utils.ts` after the 2026-06-29 refactor now centralizes HTML stripping — verify it's used by every `innerHTML` write site, not just the editor.

### M2. UI component system hygiene
* **`direction.tsx`** is unused outside itself — delete.
* **`ui/sidebar.tsx`** (702 LOC, the shadcn-style reimplementation) is never imported (the actual sidebar is `src/components/layout/Sidebar.tsx`). Decide: is this the planned sidebar layout, or scratch? If scratch, delete.
* **20+ unnecessary `"use client"` directives** in `src/components/ui/*` — this is a Vite SPA, not Next.js. Strip them.
* **`select.tsx` vs `native-select.tsx`** coexists without a documented split. Pick one as primary; the other becomes a thin shim.
* **`FieldLabel` vs `FieldTitle` data-slot collision** in `field.tsx` — pick one.
* **CVA className composition**: `button.tsx`, `item.tsx`, `marker.tsx` pass `className` through CVA. Installed CVA preserves it, so no confirmed bug; standardize `cn(variants(...), className)` for readability.
* Missing `<TooltipProvider>` and `<Toaster>` in the main app shell — add from `radix-ui` and `sonner` respectively.

### M3. Build, ops, hygiene
* **Dual lockfiles**: `bun.lock` (367 KB) + `package-lock.json` (647 KB). Pick one package manager and delete the other.
* **React version skew**: root uses React 19; `landing/` (separate Vite site) uses React 18. Decide whether `landing/` is a maintained product site or a generated marketing artifact.
* **VitePWA cache for `images.pexels.com`** runs `CacheFirst` with 50-entry / 30-day expiry — recommend `StaleWhileRevalidate` so future asset updates don't get pinned.
* **`sharp` ^0.33.5** is a native dep used by the icon generator; common Electron rebuild pain. Document the Electron `npm rebuild sharp` step.
* **ESLint** is thin. Add: `eslint-plugin-prettier`, `eslint-plugin-no-console` (warn level), `react-hooks/exhaustive-deps` at error level for files outside `ui/`. Auto-fix the 23 warnings incrementally rather than all at once.
* The current lint error (`ChatWindowContent.tsx:1754` `_onUpdateAgent` unused) is trivial to fix; remove the unused function or wire it through.

### M4. Strict-mode safety in hooks
The app is wrapped in `<StrictMode>`, so effects run twice on mount. The 25 hooks need verified effect cleanup paths: abort controllers, event listener `removeEventListener`, channel `unsubscribe`, `clearTimeout`/`clearInterval`. Especially:
* `useCanvasObjects` (timer maps) — confirm every `setTimeout` is paired with `clearTimeout` in cleanup.
* `useMultiplayerCursors` and `useItemPresence` — confirm `beforeunload`/`pagehide` cleanup so cursors don't become zombies when a tab closes.
* `useChat` and `useNetworkStatus` — abort any in-flight `fetch` on unmount.

### M5. Paste sanitization and clipboard in the document editor
The contenteditable in `DocWindowContent` does not sanitize paste. Required:
* Hook `onPaste` → `event.preventDefault()` → `dataTransfer.getData('text/html')` → run through DOMPurify with the project's allowlist → `insertHTML` the cleaned fragment.
* Same for `DocumentVersionHistory` restoration.

### M6. AuthPage hardening
`src/components/auth/AuthPage.tsx` (253 LOC) needs:
* Password policy on signup (length + complexity).
* Signin lockout after N failed attempts (with exponential back-off).
* Password reset path (or document that none exists).
* Email verification gate (or document that none exists).

### M7. File upload hardening
`src/components/files/FileUpload.tsx` (220 LOC) needs:
* MIME type validation against the project allowlist (not just `file.type` from the OS).
* Server-side size cap per workspace, enforced in `server/index.cjs:upload` handler (currently absent per C1 review).
* No virus scan expected at this stage, but flag the gap for the production-readiness checklist.

### M8. Optimistic update → server ack → realtime broadcast dedupe
The current dedupe is by `id`. With C2's `version` columns dormant, three writes can produce three fired events. Either:
* Wire `version` into optimistic concurrency (recommended).
* Or track `(id, version_seen)` in a small `useRealtimeDeduper` and drop stale events.

---

## Low Priority / Polish

* `client/src/components/cursors/*` is small and well-scoped — leave alone.
* `src/components/files/FileUpload.tsx` could later move to S3-presigned uploads; not blocking now.
* README tech-stack line still lists Vite 5 + Lucide React "1.21.0" which is below the modern fork line; verify and update.
* `tailwindcss v4` + `oklch` + complex `:has-` selectors work but are brittle. Watch for visual regressions after dependency bumps.
* `tailwind` is used both as a `devDependency` and via `@tailwindcss/vite` — confirm no unused declarations.

---

## Specific Files Worth Fixing First (priority order)

1. `netlify/functions/backend.mjs` — C1 auth/RBAC parity or removal
2. `src/components/windows/DocWindowContent.tsx` + `src/components/editor/DocumentVersionHistory.tsx` — C2 sanitization
3. `src/lib/canvasApps.ts` + applet postMessage bridge — C2
4. `src/App.tsx` — H1 decomposition into three providers
5. `server/index.cjs:2197-2199, 1621-1624, 2217-2221` + `netlify/functions/backend.mjs:747-749, 782-784` — C3 Activity idempotency
6. `src/hooks/useWindows.ts:4` + `useCanvasObjects` — H1 module-state elimination
7. `src/components/ui/direction.tsx` (delete), `ui/sidebar.tsx` (decide), `bubble.tsx`/`message.tsx` (dedupe), "use client" cleanup
8. `src/lib/backendClient.ts:129-141` — H3 stop putting token in WS query string (move to first-message auth over an existing WS connection)
9. `package.json` — remove three of four UI library ecosystems (H5); drop dual lockfile; pin AI driver versions
10. Test surface — expand beyond `backend-auth.test.cjs` to a minimum viable suite (see Test Plan below)

---

## Recommended Minimum Test Plan

The current `npm test` runs exactly one suite. Add, in priority order:

1. **`server/index.cjs` RBAC denies** — unauthenticated request, authenticated-but-wrong-workspace request, viewer trying to update, editor trying to delete workspace, role-mismatched agent creation. (Reuse the existing `backend-auth.test.cjs` harness — it has the mock scaffolding.)
2. **`netlify/functions/backend.mjs` parity negative tests** — every route in C1 must return 401 without a valid token and must enforce workspace role.
3. **Doc innerHTML roundtrip** — write a document with a known-bad payload (`<img src=x onerror=alert(1)>`, `<script>...</script>`), save, reload, assert DOMPurify output is the expected allowlist.
4. **Applet bridge** — feed an applet payload that tries to call forbidden bridge methods; assert allowed methods are accepted and forbidden are dropped.
5. **Activity idempotency** — call the same message-finalization endpoint twice; assert exactly one Activity row exists.
6. **Realtime dedupe** — fire (optimistic insert, server ack, realtime broadcast) for the same row; assert exactly one app callback.
7. **Module-level state isolation** — render `useWindows` in two browser tabs / two test components; assert z-indices are not shared.
8. **Strict-mode double-fire** — for each of the 25 hooks, render with `<StrictMode>` and assert cleanup runs and no leak.

---

## Verification (after fixes)

1. `npm run typecheck && npm run lint && npm test` — must be clean
2. Full manual flows in dev (multi-user canvas, floating windows, presence, cursors; chat + AI TASK extraction + workspace context; Activity feed including daemon placeholder finalization and retried finalization; document editing + generative UI + version restore + AI assist; applet interaction + bridge; agent + webhook + daemon; offline queue + sync; layers, sharing, roles, secrets)
3. `npm run build && npm run preview`
4. Electron dev and packaged run
5. Network tab + server logs (no secret leaks, reasonable traffic)
6. Negative HTTP probes for both backends (bad tokens, cross-workspace attempts, malicious applet content, malicious document content)
7. Re-run the focused sections of this review on the diff for each PR

---

## Open Questions

* Is the contenteditable + generative innerHTML document model the right long-term model, or should the project move to structured blocks (TipTap/Lexical) and stop carrying raw HTML through the DB?
* Applets: fully untrusted (iframe sandbox + CSP + postMessage allowlist) or workspace-trusted (any member can run any script)?
* Long-term: keep the custom realtime client + `backendClient`, replace with a typed fetch + generated types layer, or migrate to a managed realtime provider (Supabase/Pusher/Ably)?
* Primary deployment story: **local/Electron Express backend (hardened)**, **Netlify function (hardened)**, or **both via shared core**? The duplication today is the worst feature of the codebase.
* `landing/` — is it a maintained product site or a generated marketing artifact? If artifact, delete; if site, align React/Tailwind versions.

---

## Provenance

This final report merges:
* **`grok-review.md`** (2026-06-28, branch `feat/shadcn-components`) — first-pass review.
* **`ce416e4`, `ff242fb`, `3e765c9`** — three 2026-06-29 refactor commits that cleaned up dead code (`onNewChat`, sync helper), tightened realtime typings, moved password hashing to async scrypt, and centralized HTML stripping in `src/lib/utils.ts`. Reflected in the "What's working" section.
* **Two-agent parallel synthesis** (Architect + code-review-expert + pr-review-toolkit:code-reviewer + general-purpose backend specialist) that produced the existing `code-review.md` (commit `6bbd588`).
* **Swarm-planner delta analysis** (the seven-file decomposition this session): items the existing review did not enumerate — H5 dependency overlap details, H3 token-in-query-string cite, H4 rate-limit endpoints, M4 Strict-mode effect double-fire, M5 paste-sanitization cite, M6 AuthPage hardening, M7 FileUpload MIME/server-side cap, the VitePWA Pexels cache concern, ESLint rule extensions, the suggested App.tsx three-provider decomposition shape, and the Strict-mode + module-state test plan items 7–8.

Duplicate sections that existed in earlier drafts of `code-review.md` (overlap between "Frontend State & Core Findings" and "UI Component System"; overlap between "Security Findings" and "Backend + Realtime Findings" on Netlify parity and AI rate-limiting) are consolidated under Critical / High in this final. Citations use file:line; references to "`as unknown as`" / "12 `as unknown as` casts" are direct grep results from the live main checkout.
