---
name: channel-reply-format
description: How to write a reply into an agensis channel or DM so a human actually reads it. Use this before posting any status update, completion report, or answer into a workspace channel or DM — especially after finishing a build, when asked "what are you working on", "still there?", "what's the status", or when reporting verification results. The default failure mode is a wall of headers, tables and bullet lists that buries the one thing the human needs to decide; this skill replaces it with answer-first, one-ask replies.
---

# Channel reply format

Direct feedback from the human, verbatim: **"THAT is a lot to read I need it more
concise please."** The agent config also says *"keep responses concise, and
summarise any decisions giving your recommendation."* Both were repeatedly
violated by multi-section reports with 3+ tables.

## Shape

1. **First line = the answer or the decision.** Yes/no, done/blocked, the number.
   Not a header, not a preamble, not "Great question".
2. **Two to five lines of substance.** What changed and why it matters.
3. **One ask, at the end**, if you need something. Exactly one.

Target: **under ~150 words** for a status reply. A build report can go longer,
but only for the diff-level detail — never for ceremony.

## Budgets

- **At most one table**, and only when comparing ≥3 things across ≥2 dimensions.
  A verification run is not a table. `tsc ✅ · tests 236/236 ✅ · build ✅` is one
  line and reads better.
- **No section headers under ~200 words.** Headers on a 6-line message are noise.
- **No "Your move" section** listing 2–3 options with sub-bullets. One sentence:
  *"Say merge and I'll land it."*
- **No emoji-per-row status tables.** One line of results.

## Never repeat yourself verbatim

If nothing has changed since your last message, **do not re-post the same status
block**. "Still there?" gets *"Here. Nothing's changed — still waiting on your
call on X."* Re-pasting an identical branch table twice in a row (this happened)
reads as a bot, not a colleague.

## Verification reporting

State the result, not the ceremony:

> Green: typecheck, 236 unit tests, build. Not eyeballed live yet.

If you're about to write "not verified visually / headless daemon / can't see the
UI" — **stop and use `verify-ui-locally` instead.** That caveat is now usually
avoidable, and shipping it unearned is a false limitation.

## Honesty is not verbosity

Being concise never means dropping a real gap, a failed test, or something you
skipped. Compress the *prose*, never the *facts*. One sentence is enough:
*"Backend half only activates on `fly deploy` — untested until then."*

## Related

- `verify-ui-locally` — close the visual gap instead of narrating it.
- `check-already-shipped` — check before claiming anything is "waiting on you";
  a stale status block is worse than a long one.
