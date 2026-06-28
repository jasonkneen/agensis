# Full Code Review Plan — agensis (feat/shadcn-components)

**Date**: 2026-06-28  
**Branch**: feat/shadcn-components (clean working tree)  
**Scope**: Full codebase review — architecture, security, correctness, maintainability, React/TS quality, UI/shadcn, backend, realtime, testing, build hygiene, risks.

## Context
User requested "full code review please". Project is a realtime collaborative workspace (chat + docs + memory + tasks + canvas + agents + sharing) using React 19 + TS + Vite + custom Neon Postgres backend + Electron + PWA. Recent work centers on an expanded shadcn/ui component library (~60 files) and showcase.

The review must be delivered via plan file (no edits outside this file in plan mode), then exit_plan_mode for user approval. No code changes yet.

## Approach
Explored via:
- Root + src/server/agent structure listings
- Core files: App.tsx (~1400 LOC), types, configs (tsconfig*, eslint, vite, package.json, components.json)
- All major hooks (useAuth, useCanvasObjects, useChat, useDocuments, useWindows, useSharing, useWorkspaceContext, useNetworkStatus, etc.)
- Canvas system (DrawingLayer, CanvasObjectRenderer, canvasApps.ts, templates)
- Backend server/index.cjs (auth, RBAC, realtime WS, AI, agents)
- UI samples (button, dialog, select, etc.) + full subagent review of shadcn/showcase
- lib/ (backendClient, offline, utils)
- Document editor (innerHTML patterns), electron/main.cjs, minimal tests, schema, offline
- Greps for console/any/TODO/innerHTML/secrets/imports
- .gitignore, dist/release presence, database schema

Findings are evidence-based from the code (no assumptions beyond visible artifacts).

## Recommended Implementation Approach for Review
Deliver a self-contained, scannable review report (this plan file) covering:
1. Executive summary + health signal
2. Architecture
3. Categorized findings (Critical, Major, Minor, Positive)
4. shadcn-specific findings (branch focus)
5. File-by-file hotspots
6. Prioritized recommendations
7. Verification steps

Keep actionable and quantified where possible. Surface trade-offs.

## Critical Files & Areas Reviewed
**Frontend Core**
- `src/App.tsx` — monolithic orchestrator, 20+ hooks, heavy prop drilling to CanvasLayerScene (~50 props)
- `src/main.tsx` — showcase hash route
- `src/types/index.ts` — comprehensive domain types (good)
- `src/components/ui/*` (60 files) + showcase/
- Key components: DrawingLayer, CanvasObjectRenderer, DocWindowContent (windows/), FloatingWindowShell, Sidebar, etc.
- Hooks directory (25 hooks)

**Client Abstraction**
- `src/lib/backendClient.ts` — full custom Supabase-like client over HTTP+WS (QueryBuilder, LocalChannel, RealtimeManager, auth storage). Central to everything.
- `src/lib/offlineBackend.ts` + offlineDb.ts
- `src/lib/canvasApps.ts` — applet builder + runtime HTML (heavy innerHTML)

**Backend**
- `server/index.cjs` (large) — Express + postgres + ws. Includes:
  - Custom HMAC token auth + seeding
  - Workspace RBAC (owner/admin/editor/commenter/viewer)
  - Fine-grained table capability checks
  - Realtime fanout for db_changes + broadcast
  - AI proxy (Anthropic direct calls + streaming)
  - Agent daemon protocol (jobs, heartbeats, tokens)
  - Runtime schema migrations (ensureRuntimeSchema)
  - Secrets handling (workspace_secrets + app_settings)
- `database/neon-schema.sql` + netlify/migrations
- `supabase/functions/ai-chat/index.ts` (legacy path)

**Desktop / Runtime**
- `electron/main.cjs` — secure prefs (sandbox, contextIsolation), embeds backend
- `agent/agensis-cli/` — CLI daemon for external agents (bin + src)

**Config / Ops**
- `package.json`, `vite.config.ts` (PWA + proxy + base:'./' for Electron), eslint (minimal), tsconfigs (strict)
- `.gitignore` (correctly ignores dist/release/node_modules/.env)
- `components.json` (radix-nova, Tailwind v4, lucide)

**Tests**
- `tests/backend-auth.test.cjs` (mocked, limited)

## Major Observations & Findings

### Architecture Strengths
- Workspace-first model + layers (canvas) + private windows is a clean conceptual split.
- Sophisticated auth + RBAC + workspace membership enforcement (server enforces before every scoped op).
- Pluggable agent system (builtin + daemon) with hashed connect tokens, job queueing, live deltas.
- Custom client successfully abstracts backend so hooks look "Supabase-y".
- Canvas uses % coords + layers + groups + applets (extensibility).
- Offline queue + cachedFetch for resilience.
- Very few TODO/FIXME/console (only 2 in server, few in src).

### Critical / Security Risks
1. **Arbitrary code execution surface (applets)**: `src/lib/canvasApps.ts` generates and injects complete single-file HTML/JS (innerHTML + createElement) from AI prompts into `<object src="data:...">` or similar on canvas. Limited escaping (replace /[<>&"]/g in one path). Applets can call the agensis postMessage contract. If an applet iframe/sandbox is insufficient, malicious generated code runs in user context.
2. **Document editor innerHTML roundtrips**: DocWindowContent, DocumentVersionHistory, and generative UI blocks do heavy `el.innerHTML = ...` + `stripHtml` via tmp div. Good escapeHtml exists but not uniformly applied on all paths. Contenteditable HTML editing is notoriously hard to secure/sanitize.
3. **No visible rate limiting / AI cost guard**: Anthropic calls (runAnthropicCompletion) are authenticated but no per-user/workspace throttling or token budget visible in reviewed code.
4. **Client-stored session only**: AUTH_STORAGE_KEY in localStorage with no HttpOnly or additional server-side revocation (beyond signout clearing it). Token is HMAC on userId.
5. **Runtime ALTERs in prod path**: `ensureRuntimeSchema()` runs broad `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` and constraint mangling on every startup. Works for Neon but fragile for concurrent deploys/migrations.
6. **Built artifacts tracked?**: Despite .gitignore, `dist/`, `release/`, `landing/node_modules/` appear in FS listings. Verify they are not accidentally committed (git ls-files).

### Major Maintainability Issues
1. **App.tsx monolith** (~1400 lines): One component owns auth, 15+ domain hooks, window management, presence, context counts, AI extraction, layer switching, confirm dialogs, etc. Sub-component `CanvasLayerScene` receives 40–50 props. Re-render surface is huge. Inline functions + many useCallback/useMemo still present.
2. **Module-level mutable state**: `useWindows.ts` uses `let nextZIndex = 100` outside React. `useCanvasObjects` has `nextZRef`, timer maps. Hard to test / SSR / concurrent safe.
3. **Type hacks**: `setActiveSession(null as unknown as ChatSession)` (App.tsx:890). Several `as unknown as X` casts in hooks.
4. **Prop drilling & duplicate context**: Many values threaded from App through CanvasLayerScene into windows + drawing. useWorkspaceContext, presence, and itemPresence partially overlap.
5. **Realtime duplication & races**: Every hook (useChat, useDocuments, useCanvasObjects, ...) sets up its own channel + db_changes listeners. Optimistic updates + broadcast + server notify can cause duplicates (mitigated by id checks in some places). No central realtime store.
6. **Custom backendClient complexity**: ~530 LOC implementing query builder + full realtime over raw WS. Faithful but one-off; any drift between client/server protocol is painful. Error shapes are inconsistent in places.

### React / Performance / Correctness
- Large useEffect dependency arrays and derived state in App (workspacePresenceUsers, contextCounts) recompute often.
- No virtualization for canvas objects / long chat threads / document lists (risk at scale).
- Floating windows are purely local (lost on refresh). Canvas + docs persist.
- useNetworkStatus + offline queue exists but many create paths still early-return on `!navigator.onLine`.
- Strict TS + noUnused* is on — good. Few `any`.

### shadcn / UI Specific (from subagent + samples)
- High quality overall. Consistent data-slot, cva, cn(), asChild+Slot, React.ComponentProps, aria-invalid/focus-visible patterns.
- ~60 files (core + heavy custom: attachment, bubble, message*, field, item, input-group, button-group, kbd, native-select, spinner, sidebar, chart, message-scroller).
- Showcase is comprehensive and useful (live theme switching).
- **Duplication**: bubble.tsx + message.tsx have identical `*Group` implementations.
- **Inconsistencies**:
  - "use client" directives on ~half the files (unnecessary for Vite).
  - Some thin wrappers (collapsible, aspect-ratio) do almost nothing vs heavily styled ones.
  - direction.tsx is defined but unused outside itself.
  - FieldLabel vs FieldTitle data-slot collision.
  - Select and native-select coexist without clear separation documented.
- Customs are genuinely used in production UI (chat, files, settings, agents, etc.).
- Accessibility relies on radix primitives — generally good, lighter on custom message UI.
- Tailwind v4 + oklch + complex :has- selectors work but can be brittle.

### Backend & Data
- Excellent intent on access control (enforceWorkspaceRole, DB_TABLE_ACCESS maps, resolveOperationWorkspace).
- Token auth + password hash (scrypt) implemented cleanly.
- Agent protocol is sophisticated (register, heartbeat, job result/delta, live message updates).
- AI system prompt construction is thoughtful (context injection, TASK: extraction hook).
- Schema has `version` columns on most tables (intended for optimistic concurrency?) but client rarely uses them.
- Messages lack full-text search or pagination (all loaded).

### Testing / Quality
- Minimal tests (only backend-auth with heavy mocking).
- No unit tests for hooks, canvas logic, RBAC paths, or UI components.
- Manual testing via dev + showcase + electron is primary.
- Lint is basic (react-hooks + refresh). No prettier or stricter rules visible.

### Build / Ops / Hygiene
- Good PWA + Electron base config.
- Scripts for neon push, icon gen, electron dev/dist.
- .env and secrets handled reasonably (never in client).
- release/ contains full DMGs and .app — should never be in source control.
- landing/ has its own full node_modules + lock (separate Vite site?); risk of drift.
- No lockfile consistency (bun.lock + package-lock.json present).

### Positive Highlights
- Thoughtful product model (layers, private windows, presence, agents).
- Strong security model on paper (RBAC, secrets in DB, hashed agent tokens, server-side AI keys).
- Modern, polished UI system with real usage.
- Clean from console spam / TODO debt.
- Good separation of realtime concerns in hooks.
- Useful showcase for the component work.

## File Hotspots (priority for fixes or deep review)
- `src/App.tsx` (monolith, type hacks, prop drilling)
- `src/lib/backendClient.ts` + server realtime/notify paths
- `src/lib/canvasApps.ts` (applet security)
- `src/components/windows/DocWindowContent.tsx` + editor files (innerHTML)
- `src/hooks/useWindows.ts` + useCanvasObjects.ts (module state)
- `server/index.cjs` (ensureRuntimeSchema, AI routes, agent WS handlers — long file)
- `src/components/ui/bubble.tsx`, `message.tsx`, `field.tsx`, `direction.tsx`, `sidebar.tsx`
- `src/components/ui/*` for "use client" cleanup and duplication
- `package.json` / file lists in electron-builder (ensure no release/ artifacts)
- `database/neon-schema.sql` + runtime migrations

## Prioritized Recommendations
**Immediate (before more features)**
1. Add iframe sandbox + CSP for canvas applets. Treat generated HTML as untrusted.
2. Audit + centralize HTML sanitization for docs + applets. Prefer DOMPurify or strict allowlist.
3. Extract substantial pieces from App.tsx (e.g., usePresenceManager, useKnowledgeContext, window orchestration hook or context).
4. Remove or document module-level counters (nextZIndex). Move to state or a stable factory.
5. Add at least smoke tests for auth paths + canvas object CRUD + RBAC deny cases.
6. Confirm dist/release/landing/node_modules are .gitignored in practice (`git ls-files --error-unmatch dist 2>/dev/null || true`).

**Short term**
- Unify realtime subscription management (central hook or singleton manager).
- Add simple server-side rate limit / usage log for AI calls.
- Decide on document model (contenteditable HTML vs structured/blocks). If keeping HTML, own the sanitizer.
- Clean shadcn: remove unused "use client", delete or integrate direction.tsx, dedupe Group components, document select vs native-select.
- Use row `version` for conflict detection on updates (canvas, docs) or remove the columns.

**Medium / Long**
- Consider a lightweight state manager (or React context slices) to reduce prop drilling.
- Virtualized canvas / chat lists when object/message counts grow.
- Proper migration system instead of runtime ALTERs for schema.
- Add e2e or Playwright flows for core collab scenarios.
- Evaluate replacing custom backendClient with a thinner typed fetch layer + generated types if backend stabilizes.
- Extract agent protocol into shared types (client + server + agent).

## Verification Steps (End-to-End)
1. `npm run typecheck` — must pass (strict mode).
2. `npm run lint` — clean.
3. `npm test` — current tests pass.
4. `npm run dev` + manual flows:
   - Sign up / sign in (multiple users via different browsers)
   - Create workspace, invite member, change role
   - Draw shapes/pen/sticky, move, group, bring-to-front, delete
   - Open multiple floating windows (chat/doc/memory/tasks/agents), minimize/restore/focus
   - Send chat, verify TASK: extraction creates real tasks
   - Use workspace knowledge toggle
   - Create agent + webhook + connection simulation (if daemon available)
   - Offline: disable network, create doc/canvas item, come back online
   - Layers: create new canvas layer, switch, delete (with confirm)
5. `npm run build && npm run preview`
6. Electron: `npm run electron:dev` (or dist if packaged)
7. Showcase: visit `/#showcase` and exercise major components + theme switcher.
8. Review server logs during AI + agent activity.
9. Inspect Network tab for no leaked secrets.
10. Optional: run a second instance or use curl against /backend/* with bad tokens to verify 401/403.

## Scope Notes for Execution
- Do not expand scope beyond review unless user asks (no "while we're here" refactors).
- When implementing fixes later, prefer small, targeted PRs (App split, sanitizer, tests, shadcn cleanup).
- Verify every security-sensitive change with both positive and negative test cases.

## Open Questions for User (if needed before coding)
- How important is the contenteditable document model vs moving to a structured editor?
- Should canvas applets be treated as fully untrusted user content (stronger sandbox)?
- Is the custom realtime client worth keeping long-term, or migrate toward a standard solution?
- Priority order for recommendations?

This plan is the complete review artifact. After user approval, implementation can proceed in follow-up steps with todo tracking.
