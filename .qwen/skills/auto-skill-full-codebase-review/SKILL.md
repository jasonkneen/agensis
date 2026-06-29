---
name: full-codebase-review
description: Conduct a comprehensive codebase review using parallel exploration agents to analyze architecture, code quality, security, and performance across all layers of a project.
source: auto-skill
extracted_at: '2026-06-29T08:48:29.135Z'
---

# Full Codebase Review

Perform a thorough code review of an entire project by coordinating multiple parallel exploration agents, then synthesizing findings into a prioritized improvement plan.

## When to Use

- User asks for "full breakdown", "code review", "codebase audit", or "comprehensive review"
- Before major refactoring to understand technical debt
- Onboarding to a new codebase
- Pre-release quality gate

## Procedure

### Phase 1: Initial Orientation (1-2 minutes)

Read the project's identity files to understand scope:
- `package.json` / `Cargo.toml` / `pyproject.toml` (dependencies, scripts, project metadata)
- `README.md` (purpose, architecture overview, setup instructions)
- Top-level directory structure (`src/`, `server/`, `lib/`, `components/`, etc.)
- Entry points (`main.ts`, `App.tsx`, `index.js`, etc.)

This gives you: project type, tech stack, size estimate, and architectural layers.

### Phase 2: Parallel Deep Exploration (3-5 minutes)

Spawn **3 specialized exploration agents** simultaneously, each covering a distinct architectural layer. Each agent should read files **fully** (not just summaries) and report structured findings.

#### Agent 1: Backend & Data Hooks
**Scope:** Server code, API routes, database layer, data-fetching hooks, authentication, realtime/WebSocket logic.

**Files to read:**
- Server entry point (e.g., `server/index.cjs`, `src/server.ts`, `app.py`)
- All data hooks or service modules (e.g., `useAuth.ts`, `useChat.ts`, `useDocuments.ts`)
- Database schema (`schema.sql`, migrations, `models/`)
- Client-side backend adapter (e.g., `backendClient.ts`, `api.ts`)
- Offline/storage layer (e.g., `offlineDb.ts`, `offlineBackend.ts`)

**What to report per file:**
- Line count and complexity (trivial / low / medium / high / very high)
- Security issues (auth token handling, input validation, SQL injection, secrets exposure)
- Performance issues (synchronous blocking, unbounded caches, missing pagination, N+1 queries)
- Error handling quality (silent `.catch(() => {})`, missing rollbacks, swallowed errors)
- Dead code or unreachable paths
- Type safety gaps (excessive casting, `any` usage)

#### Agent 2: Components & UI Layer
**Scope:** All visual components, layout, windows/panels, canvas/drawing, accessibility.

**Files to read:**
- Full recursive listing of `src/components/` (every subdirectory)
- Key UI files: layout (Sidebar, Header), main content areas (Chat, Editor, Canvas), dialogs (Settings, Share), search/command palette, auth pages
- Styles (`index.css`, theme files, Tailwind config)
- Entry points (`main.tsx`, `App.tsx`)
- Build config (`vite.config.ts`, `next.config.js`)

**What to report per file:**
- Line count and complexity
- Component size warnings (>500 lines = needs decomposition)
- Prop drilling depth (count props on main component; >15 = needs context)
- State proliferation (>15 `useState` = needs extraction)
- Accessibility gaps (missing keyboard nav, no ARIA, mouse-only interactions)
- Direct DOM manipulation (`document.execCommand`, `innerHTML`, raw `addEventListener`)
- Duplicated utilities across components
- Missing `React.memo` on list items

#### Agent 3: Hooks, Libs, CLI, Config
**Scope:** Remaining hooks, utility libraries, CLI tools, showcase/demo code, configuration files.

**Files to read:**
- All remaining hooks not covered by Agent 1
- All files in `src/lib/` or equivalent
- CLI/agent code (e.g., `agent/agensis-cli/`)
- Showcase/demo directory
- Config files (`.env.example`, `tsconfig*.json`, `eslint.config.js`, `components.json`)

**What to report per file:**
- Line count and complexity
- Code duplication across hooks (shared patterns that should be factories)
- Cleanup pattern inconsistencies (some use `unsubscribe()`, others `removeChannel()`)
- Type duplication (same interface declared in multiple files)
- Missing error states in hooks (silent failures)
- Config completeness (`.env.example` vs actual env vars used)

### Phase 3: Synthesis & Prioritization (2-3 minutes)

After all agents return, synthesize findings into a structured report:

#### Report Structure

```markdown
## Project Overview
- Tech stack, total LOC, number of files, architectural pattern

## Architecture Summary
| Layer | Key Files | Lines | Concern |
|-------|-----------|-------|---------|

## Top N Largest Files
| File | Lines | Concern |

## 🔴 Critical Issues (Fix First)
Issues that are security vulnerabilities, data-loss risks, or severe performance bugs.
Each entry: **what** → **where** (file + function) → **impact** → **fix**

## 🟠 High Priority Issues
Major maintainability blockers: god-components (>2000 lines), monolithic files, missing state management, complex functions (>100 lines).

## 🟡 Medium Priority Issues
Code duplication, missing abstractions, deprecated APIs, inconsistent patterns.

## 🟢 Low Priority / Nice-to-Have
Missing memoization, dead code, type gaps, accessibility improvements.

## ✅ Strengths & Positive Patterns
What the codebase does well — consistent patterns, good abstractions, solid architecture decisions.

## Recommended Fix Order
Phased plan: Quick wins → Decomposition → Security → Polish
```

### Phase 4: Prioritization Criteria

Use this hierarchy to rank issues:

1. **Security vulnerabilities** (token leaks, no auth expiry, SQL injection, no rate limiting)
2. **Data loss risks** (offline queue stuck, no error rollback, missing cascade deletes)
3. **Performance blockers** (event loop blocking, re-subscribe every render, unbounded caches)
4. **Maintainability walls** (files >2000 lines, functions >100 lines, 30+ prop interfaces)
5. **Code duplication** (same utility in 3+ files, copy-paste hooks)
6. **Deprecated APIs** (`document.execCommand`, legacy patterns)
7. **Missing polish** (accessibility, memoization, dead code)

## Key Principles

- **Read files fully** — don't summarize from filenames alone; bugs hide in implementation details
- **Count lines** — file size is the single best predictor of maintainability problems
- **Check every hook for:** realtime subscription pattern, error handling, cleanup, memoization
- **Check every component for:** state count, prop count, direct DOM access, accessibility
- **Check server for:** auth token design, synchronous operations, unbounded caches, input validation
- **Look for cross-cutting duplication** — utilities, types, and patterns repeated across files
- **Always report strengths** — a review that only lists problems is demoralizing and incomplete
- **Phase the fix plan** — quick wins first (high impact, low effort), then decomposition, then polish

## Phase 5: Systematic Implementation (if user says "do it")

When the user wants you to implement the fixes, follow this execution procedure:

### Execution Order

1. **Quick wins first** (critical bugs with small diffs): memoization fixes, dead code removal, cache eviction
2. **Shared extractions** (new files + import updates): shared types, shared utilities — these cascade to many files
3. **Decompositions** (large function/component splits): break apart god-functions into named sub-callbacks
4. **Security fixes** (auth, crypto, input validation): always verify call sites handle the new async/error signatures
5. **Verify at the end**: `npm run typecheck` and `npm run lint` — expect zero NEW errors

### Pre-Edit Checklist (per file)

Before editing any file, always:
1. **Re-read the file** to confirm its current state (it may have changed since your earlier exploration)
2. **Search for all call sites** of any function you're changing (e.g., sync→async requires `await` at every callsite)
3. **Check for unused imports** after removing local type declarations — the typecheck will catch these but it's faster to clean proactively

### Hard-Won Implementation Lessons

**Memoization fixes:**
- Use `useMemo` for derived values (computed from props/state), `useCallback` for functions
- An unmemoized value in a `useCallback` dependency array causes the callback to change identity every render, which cascades to `useEffect` re-runs and event listener thrashing
- Fix the dependency chain: `displayName` → `sendCursor` → `handleMouseMove` → `useEffect` cleanup/setup

**LRR cache with plain `Map`:**
- `Map` insertion order = iteration order, so delete-and-re-insert gives LRU behavior
- Evict by iterating `keys()` from the start (oldest first) until the excess is removed
- Wrap in named helpers (`cacheGet`/`cacheSet`) rather than inline `Map` access

**Async crypto migration:**
- `promisify(crypto.scrypt)` returns a function that resolves to `Buffer` — same API shape as `scryptSync`
- Every callsite must `await` the result; grep for all usages before editing
- If the function is called inside a SQL parameter array (`[email, hashFn(password)]`), add `await` to the call expression

**Shared type extraction:**
- Create one canonical file (`src/types/realtime.ts`) with the most permissive union of all local variants
- The `send` method should be required (not optional) if any consumer calls it — optional causes `TS2722` at callsites
- After replacing local type declarations, run typecheck to find unused imports immediately

**`stripHtml` shared utility:**
- Use DOM-based stripping (`document.createElement('div')`) in browser for accuracy
- Provide a regex fallback for SSR/non-browser contexts
- Don't force-migrate all variants — if a local version is intentionally different (e.g., password normalization that preserves case), leave it alone

**Queue flush skip-and-continue:**
- Replace `break` on error with `continue` — one permanently-broken item should not block the entire queue
- Track `failedCount` and report aggregate error message, not per-item message
- Remove now-unused helper functions (`getErrorMessage`) to satisfy `noUnusedLocals`

**Function decomposition pattern:**
- Extract named `useCallback` functions for each concern: `insertUserMessage`, `autoTitleSession`, `dispatchToAgent`, `streamDirectAI`
- The orchestrating function (`sendMessage`) becomes a readable sequence of calls
- Each sub-callback gets a narrow dependency array; the orchestrator lists all sub-callbacks

**Generic hook factory with config object:**
- Define a `Config` interface with: `table`, `filterField`, `channelPrefix`, `buildInsertPayload`, `castRow`
- The factory hook takes `config` + `filterValue` + `workspaceId` + `userId`
- Concrete hooks become thin wrappers: `return useRealtimeComments<T>(config, ...)`
- The `CommentRow` constraint interface should NOT use index signatures (`[key: string]: unknown`) — they conflict with concrete interfaces that lack them

**Offline payload normalization:**
- `offlineUpdate` must send the same field names to the server AND the queue
- Add `updated_at` to both the server payload and the queued payload
- The `id` goes in the queue payload (for replay) but is stripped from the server payload (the `.eq('id', id)` handles it)

### Post-Implementation Verification

After all fixes are applied:
1. Run `npm run typecheck` — must pass with zero new errors
2. Run `npm run lint` — must have zero new errors (warnings are acceptable if pre-existing)
3. Common cleanup needed: remove unused imports (`BroadcastSendMessage`, `getErrorMessage`), remove unused destructured variables, fix `null` vs `undefined` in type signatures

## Anti-Patterns to Flag

| Pattern | Where to look | Why it matters |
|---------|---------------|----------------|
| Tokens without expiry | Auth/token code | Permanent access on leak |
| Unbounded caches | `Map`/`Set` with no eviction | Memory leak in long-running processes |
| Sync crypto/FS on server | `scryptSync`, `readdirSync` | Blocks event loop |
| Re-subscribe every render | `useEffect` with unmemoized deps | Perf drain, WebSocket churn |
| God-component | >2000 lines, >20 useState | Unmaintainable, untestable |
| 30+ prop interface | Component prop types | Needs context/store |
| Silent `.catch(() => {})` | Server error handling | Bugs invisible in production |
| `document.execCommand` | Rich text editors | Deprecated, inconsistent |
| No offline queue drain | IndexedDB/offline code | Queued mutations never sync |
| Duplicated types | Same interface in 3+ files | Drift risk, maintenance burden |
