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
