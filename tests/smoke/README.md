# The smoke gate — `npm run smoke`

Boots every main surface with data in it and fails if the surface is showing an
empty state anyway.

## Why it exists

On 2026-07-27 a workspace holding **8 agents** rendered:

> No agents match — You haven't created any agents yet.

over the full list, with nothing on screen to undo it. `ownerFilter` is a
**persisted** preference and the Mine/All toggle only rendered when the filter
had matches, so a stored `'mine'` in a workspace whose agents were created by
someone else hid every agent *and* the only control that could clear it.
Unrecoverable from the UI, and it looked exactly like data loss.

`npm run typecheck`, `npx eslint .`, `npm run test:unit` (1735), `npm test`
(1158) and `npm run build` were **all green** — verified again while writing
this, against the pre-fix code. None of them renders the app, so none of them
could see it. That is the gap this layer closes.

## What it asserts

Not "it rendered". The assertion is:

> **An empty state must not be showing while data exists.**

Each surface is seeded with 8 items carrying unmistakable markers
(`SmokeAgent01`, `SmokeTask01`, …). All 8 must be on screen and none of that
surface's "nothing here" copy may be.

Second, and this is the half that catches the incident:

> **A persisted preference must never hide the control that clears it.**

`trapStates.smoke.ts` writes a preference to `localStorage` that filters
everything away, mounts the surface, and requires *recovery*: either the filter
yields and the items show anyway, or some single control on screen brings them
back when clicked. Controls are clicked one per **fresh mount**, with
`localStorage` restored in between (the persisted setters write back, so
without that an earlier click contaminates every later attempt), and the prober
follows one level into a dropdown or select because that is where the way out
often lives.

## Why jsdom and not a browser

- **Playwright is not a dev dependency here.** Adding it means a new npm
  dependency plus a ~150 MB browser download — and this gate has to be runnable
  offline, on a fresh checkout, by a daemon.
- **The repo already mounts real components in jsdom** (`tests/unit/
  tasksWindowRender.test.ts`, `vaultPanelRender.test.ts`, `windowBodies.test.ts`).
  This is that pattern applied at surface scale, so it is idiomatic to maintain.
- **There is no login to get past.** Surfaces are mounted directly, so the gate
  needs no session token, no seeded database, no private vite port, and cannot
  contend with another agent's browser.
- **It is fast.** ~10 s warm, ~35 s cold. A gate that is slow gets skipped.

Three surfaces — Inbox, Tenants, Memory — load their own data, and are mounted
against a **seeded fetch router** (`backend` in `harness.ts`) rather than given
props. For those the gate covers the whole path: hook, request, parse, render.

## Adding a surface

Add a case to `surfaces.smoke.ts` with the component, its seed, and its empty-state
copy. If it is fed by a hook that fetches, register rows on `backend.tables`
(for `backendClient` reads, keyed by table) or `backend.routes` (for bespoke GET
routes, keyed by a URL substring).

## Adding a persisted filter

The coverage guard at the bottom of `trapStates.smoke.ts` scans `src/` for every
`usePersistedPreference` call site and fails until the new preference is either
in `TRAPS` or in `NOT_A_FILTER` with a reason it cannot empty a list. This is on
purpose: a check nobody remembers to extend is a check that quietly stops
covering things.

## When it fails

The failure names the surface and what it saw:

```
Agents [owner filter 'mine' with no agents created by the current user]:
TRAP STATE. A stored preference hides all 8 seeded items and none of the 11
controls on screen brings them back. Controls offered: Grid view | Map view |
… | Disconnected8 | Inactive0.
  what it painted -> .smoke-failures/Agents__owner_filter__mine….txt
  first 400 chars: Invite an AgentCreate AgentAll8Active0…No agents match
                   You haven't created any agents yet.
```

`.smoke-failures/<surface>.txt` holds everything the surface painted — the
jsdom equivalent of a screenshot, and enough to read the bug without
reproducing it.

## What it still cannot catch

- **Anything visual.** jsdom computes no layout: zero-height containers,
  `overflow: hidden` clipping, white-on-white text, a panel off-screen. The
  surface's text is in the DOM either way.
- **The App-level wiring.** Surfaces are mounted directly, so a regression in
  `App.tsx` that fetches the agents and forgets to pass them down would not
  fail this gate. (The three self-loading surfaces are the exception.)
- **Real data.** No database, no live backend, no auth. A backend route that
  returns the wrong rows is a job for `npm test`.
- **Interactions past the first click.** The trap prober goes one level deep,
  which covers a dropdown; it is not a general UI crawler.
