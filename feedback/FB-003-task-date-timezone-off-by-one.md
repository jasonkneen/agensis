# FB-003 — Task dates set via API/MCP display one day early

- **Task ID:** `938aeb7a-f04b-45a2-97af-4466f2c1c862`
- **Reporter:** 56bf0ff4-f573-435e-95a2-865b9c42ebe9
- **Page:** /app — Main
- **Status:** todo → done (this writeup only; no code changed)
- **Related task referenced by reporter:** `50c7f6ea-faeb-4890-997f-fd233326720a`
- **Note:** this report also repeats the FB-004 "Send button off-screen" complaint — see FB-004, same fix covers both.

## Original message

> Task dates set via the API display one day early. The UI and the API store the same calendar date as two different instants.
> Expected: a date displays as the date I set, whichever path set it.
> Actual: API-set dates show a day early. UI-set dates are correct.
> Set over MCP — start_date "2026-07-27", due_date "2026-07-29"
>   stored: 2026-07-27T00:00:00.000Z / 2026-07-29T00:00:00.000Z  (UTC midnight)
>   shown:  07/26/2026 and 07/28/2026, card chip 7/28
> Set the same two fields in the UI
>   stored: 2026-07-30T05:00:00.000Z / 2026-07-31T05:00:00.000Z  (local midnight, I'm UTC-5)
>   shown:  correctly
> So the UI writes local midnight, the API writes UTC midnight, and only the first round-trips. Any integration setting a date over MCP silently stores a day the user never picked.
> Task id 50c7f6ea-faeb-4890-997f-fd233326720a.
> Untested but implied by the storage format: two users in different zones storing "the 30th" write different instants and each sees the other's shifted.
> (Also: the Send button viewport bug — see FB-004.)
>
> Page: /app — Main

## What I found in the codebase

`tasks.start_date`/`due_date` are `timestamptz` (`supabase/migrations/20260718123000_task_start_date_and_dependencies.sql:11`) — the column itself can't distinguish "a calendar date" from "an instant," so it all comes down to a write/read convention, and the two write paths use different ones:

1. **MCP write path stores UTC midnight** — `server/mcp.cjs:141-151` (`optDateArg`):
   ```js
   const ms = Date.parse(value);
   ...
   return new Date(ms).toISOString();
   ```
   `Date.parse('2026-07-27')` follows the spec rule that a date-only ISO string with no time/offset parses as **UTC midnight**. Used by `create_task`/`update_task` at `server/mcp.cjs:752-753, 828-829`.

2. **UI write path stores local midnight** — `src/components/windows/taskSchedule.ts:49-62` (`fromDateInputValue`):
   ```js
   const d = new Date(year, month - 1, day);   // local midnight
   ...
   return d.toISOString();
   ```
   A comment at line 46 already calls out the trap this code avoids: *"Building the Date from `new Date(value)` instead would parse as UTC and shift the day for anyone behind UTC."* — i.e. the UI team already hit and fixed this once, just not on the MCP side.

3. **Display assumes the local-midnight convention** — `taskSchedule.ts:21-32` (`startOfDay`/`dayFromIso`) and `TasksWindowContent.tsx:691, 1920` (`new Date(task.due_date).toLocaleDateString()`) both convert the stored instant to **local** wall-clock before extracting the day. Correct for UI-written values, wrong for MCP-written ones: for a UTC-5 user, `2026-07-27T00:00:00.000Z` is `2026-07-26T19:00` local, landing display on the 26th — exactly the reported shift (07/27→07/26, 07/29→07/28).

**Root cause:** two producers disagree on what "date-only" means (`Date.parse` → UTC anchor vs. `new Date(y,m,d)` → local anchor), but only one consumer convention (local) exists to reverse it.

## Recommendation

Make `optDateArg` in `server/mcp.cjs` build dates the same way `fromDateInputValue` does: detect the `^\d{4}-\d{2}-\d{2}$` shape and construct explicit midnight components rather than `Date.parse`. Better still, standardize the *whole* pipeline on UTC-midnight-as-calendar-date (since that's timezone-agnostic) rather than local-midnight:

- `server/mcp.cjs` `optDateArg`: build `new Date(Date.UTC(y, m-1, d))` for date-only input.
- `taskSchedule.ts` `fromDateInputValue`: emit UTC midnight too, instead of local midnight.
- `startOfDay`/`dayFromIso`/`toDateInputValue` and the display formatters (`TasksWindowContent.tsx:691, 1920`): read **UTC** components (`getUTCFullYear`/`getUTCMonth`/`getUTCDate`) instead of local ones.

This makes date-only task fields genuinely timezone-agnostic — fixing both the MCP path and the cross-timezone case the reporter flagged as untested (two users in different zones storing "the 30th" currently write different instants and would see each other's dates shifted).
