# Contributing

Thanks for taking an interest. This file covers getting the project running and
the handful of things that will waste your afternoon if nobody tells you about
them.

**[AGENTS.md](./AGENTS.md) is the deep reference** — architecture, the
schema-sync rule, realtime, authorization boundaries, and the reasoning behind
the constraints. Read it before changing anything on the backend. This file is
the short version.

## Local setup

Requires Node 22 (see `.nvmrc`) and a Postgres database. The project is developed
against [Neon](https://neon.tech), but any Postgres 15+ will do.

```bash
npm install
```

Create a `.env` in the repo root:

```bash
DATABASE_URL=postgresql://user:password@host/db?sslmode=require
AUTH_SECRET=<any long random string for local dev>
ANTHROPIC_API_KEY=<optional; needed only for AI chat>
```

Apply the schema, then run the two processes:

```bash
npm run db:neon:push     # schema -> database/neon-schema.sql
npm run backend          # API + websocket server on :3001
npm run dev              # Vite dev server
```

`npm run dev:full` starts both together if you would rather have one terminal.

## Before you open a pull request

```bash
npm run ci
```

That is the single gate: typecheck, then the backend suite, then the frontend
unit suite, then the smoke gate, then lint — in
that order, stopping at the first failure.

Run it **locally**. Do not infer "tests passed" from CI; see
[Verify before you ship](./AGENTS.md#verify-before-you-ship-every-change) in
AGENTS.md for why that has not been a reliable signal on this repository.

## The test-glob trap

**This is the one that catches everyone.** There are two runners with two
non-overlapping, non-recursive globs, and a test file outside both is not an
error — it silently never runs, forever, while `npm run ci` stays green.

| Runner | Command | Glob | Framework |
| --- | --- | --- | --- |
| Backend | `npm test` | `tests/*.test.cjs` | `node:test` |
| Frontend | `npm run test:unit` | `tests/unit/**/*.test.ts` | Vitest (jsdom) |

Read those globs literally:

- `tests/*.test.cjs` has **one** star. A `.test.cjs` in `tests/anything/` is not
  matched.
- `tests/unit/**/*.test.ts` is recursive but rooted at `tests/unit/`. A
  `.test.ts` anywhere else — `tests/foo.test.ts`, `src/**/*.test.ts` — is not
  matched.
- `.test.tsx` is not matched by either. Name frontend tests `.test.ts`.

This has already cost this project a 34-test suite that sat in the tree looking
like coverage while never executing once. If you add a test, **make it fail on
purpose first** and confirm the runner reports the failure. If it stays green,
your test is not running.

Two further runners exist and are wired into `npm run ci`:

| Runner | Command | Scope |
| --- | --- | --- |
| Smoke | `npm run smoke` | `vitest.smoke.config.ts` — renders the app. Not optional; it catches the class of bug where every other check is green and the UI is broken. |

## Working on the code

- **Match the surrounding file.** 2-space indent, the file's existing semicolon
  convention, `cn()` for class merging, and the shadcn/ui primitives already
  imported there.
- **No new npm dependencies without a strong reason.** Drag-and-drop is native
  HTML5 or pointer events; there is no DnD library and there should not be one.
- **Schema changes land in three places at once.** See the schema-sync rule in
  AGENTS.md. Missing one produces a table that exists on one backend and not the
  other, which fails at runtime and not at build time.
- **Adding a table to `ALLOWED_TABLES` is four edits, not one.** `ALLOWED_TABLES`
  alone gives you zero row scoping. AGENTS.md has the worked example; follow all
  four steps in the same commit.
- **User-facing rich text goes through `src/lib/sanitize.ts`** at every render
  and paste boundary.

## Commits and pull requests

- One logical change per PR. A refactor and a behaviour change in the same diff
  is two PRs.
- Write the commit subject as what changed for a user or an operator, not as
  what you typed.
- If you ship a user-visible change, add an entry to
  `public/release-notes.json`. Nothing generates it; the shape test cannot tell
  that you forgot.
- If you change behaviour that AGENTS.md documents, update AGENTS.md in the same
  commit. A doc that describes a boundary the code no longer enforces is worse
  than no doc.

## Security

Do not report vulnerabilities as public issues. See
[SECURITY.md](./SECURITY.md).

## Licence

Contributions are accepted under the [GNU AGPL v3.0](./LICENSE), the same licence
this project is distributed under. By opening a pull request you confirm you
have the right to contribute the code under those terms.

If your change adds a dependency or a media asset, check
[NOTICE](./NOTICE) and [ASSETS.md](./ASSETS.md) — a new dependency whose licence
requires attribution needs a NOTICE entry, and a new image needs an ASSETS.md
entry recording where it came from, in the same PR.
