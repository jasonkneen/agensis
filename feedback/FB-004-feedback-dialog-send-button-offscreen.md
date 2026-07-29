# FB-004 — Long feedback reports push the Send button off-screen (unsendable)

- **Task ID:** `da81f97e-c4e0-416f-aabb-08e0d5abbd2b`
- **Reporter:** The Oracle (truman) (56bf0ff4-f573-435e-95a2-865b9c42ebe9)
- **Page:** /app — Main
- **Status:** todo → done (this writeup only; no code changed)
- **Duplicate:** the same bug is also called out inside FB-003's report ("once this box gets long the Send button drops below the window with no way to scroll to it"). One fix closes both.

## Original message

> Expected: to be able to send a report of any length.
>
> Actual: once the "What happened?" box grows past roughly 20-25 lines, the dialog extends below the browser window and the Send feedback button ends up off-screen. Nothing scrolls to it — not the dialog, not the page. The report can't be submitted at all.
>
> Workaround is deleting text until the button comes back into view.
>
> Flagging it because it filters in the wrong direction: a one-line "this is broken" always sends, but a report with reproduction steps and payload dumps can't. I've trimmed two reports today to fit, and this one is short for the same reason.
>
> Diagnostics attached — viewport height is the relevant variable.
> - The Oracle (truman)
>
> Page: /app — Main

## What I found in the codebase

Three compounding gaps, all in the feedback dialog, none of which cap height to the viewport:

- **`src/components/ui/dialog.tsx:59-66`** — `DialogContent`'s class list has a `max-w-*` cap but **no `max-h-*`/`overflow-y-*`** at all. It's centered via `fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`, so as content grows it expands off both the top and bottom of the viewport with nothing to stop it.
- **`src/components/ui/textarea.tsx:9`** — sets `field-sizing: content` via the `field-sizing-content` class, which auto-sizes the element to its text content, overriding the `rows={4}` prop passed in `FeedbackDialog.tsx:97-104`. There's a `min-h-16` floor but no `max-h` ceiling, so the box truly grows without bound.
- **No scrollable body wrapper** — the only `ScrollArea` in `FeedbackDialog.tsx` is the nested diagnostics preview at line 183 (`max-h-48`), scoped to the collapsed "Review what will be sent" panel. The main `FieldGroup` (lines 94-200, containing the textarea) and `DialogFooter` (204-212) sit in plain document flow inside the unbounded `DialogContent` — so once total height exceeds the viewport, nothing (dialog or page) can scroll to reach the footer.

This matches the report precisely: short text keeps the dialog under `100vh` so the footer stays visible and it submits fine; a long report pushes total height past the viewport and the Send button is carried off-screen with no scroll path back.

## Recommendation

- Give `DialogContent` (or a class override scoped to this dialog) `max-h-[90vh] overflow-hidden flex flex-col`.
- Keep `DialogHeader` and `DialogFooter` as non-scrolling `flex-shrink-0` rows.
- Wrap the `FieldGroup` + error text (`FeedbackDialog.tsx:94-202`) in a `min-h-0 flex-1 overflow-y-auto` div so only the body scrolls.
- Optionally also cap the Textarea itself at `max-h-[40vh] overflow-y-auto` so it becomes internally scrollable rather than relying solely on the outer wrapper.

Small, contained CSS/layout fix — no schema or logic changes needed. Recommend prioritizing since it currently makes detailed bug reports (the most useful kind) unsendable.
