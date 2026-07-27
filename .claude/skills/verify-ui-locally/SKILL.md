---
name: verify-ui-locally
description: Actually look at the agensis UI before reporting on it, instead of saying "I can't eyeball it, I'm a headless daemon". Use this whenever you change anything under src/components or src/App.tsx, whenever a human asks "does it look right", "can you see this", or describes a visual bug (clipping, spacing, layout, an icon row, a popover), and before writing any report that would otherwise contain the phrase "not verified visually". A Playwright MCP browser and a local vite dev server are both available in this repo, so a rendered screenshot is nearly always obtainable — the only real barrier is the login wall, and this skill covers that too.
---

# Verify agensis UI locally

There is a working browser. Claiming "headless daemon, can't see the UI" without
trying this first is a false report.

## The loop

1. **Start vite** (background, from the repo root):

   ```bash
   cd /Users/jkneen/Documents/GitHub/agensis && (npm run dev > /tmp/agensis-vite.log 2>&1 &) ; sleep 6; tail -5 /tmp/agensis-vite.log
   ```

   Serves on **http://localhost:5173** (vite default — *not* 1420; that number in
   the sibling `flows` CLAUDE.md is a different project).

2. **Navigate** — `mcp__plugin_playwright_playwright__browser_navigate` to
   `http://localhost:5173/`.

3. **Screenshot** — `browser_take_screenshot` with a **relative** `filename`
   (e.g. `agensis-local.png`). Absolute paths like `/tmp/x.png` are rejected:
   *"File access denied … outside allowed roots"*. Allowed roots are the session
   cwd and its `.playwright-mcp/`.

4. **Read the PNG back with the Read tool.** The screenshot tool only writes the
   file — you have not seen anything until you `Read` it. This is the step that
   turns "I changed some Tailwind" into an actual observation.

5. `browser_snapshot` for the accessibility tree when you need element refs to
   click/hover; `browser_console_messages` for JS errors.

## The login wall (the one real blocker)

`http://localhost:5173/` renders the **"Welcome back" sign-in card**, not the
workspace. Logged-out UI (auth, landing, onboarding first screen) is fully
verifiable as-is. For anything inside the workspace you need a session.

- Session lives in `localStorage` under **`agensis_local_session`**
  (`src/lib/backendClient.ts:12`, written at `:205`).
- To get in: ask the human **once** to paste that localStorage value, then inject
  it with `browser_evaluate` before navigating. Or ask for the password to the
  documented test account `testing@bouncingfish.com`
  (see `scripts/reset-test-account.cjs`) and type it into the form.
- Credentials are **not** in `.env` — don't hunt for them, and don't mint a
  session by writing to `DATABASE_URL` yourself. Ask.

If you're blocked on auth, say *"logged-out screens verified, workspace screens
need a session — paste `agensis_local_session` and I'll look"*. That is a
concrete unblock request, not the old vague "can't eyeball it".

## Local frontend hits the PRODUCTION backend

`VITE_BACKEND_BASE_URL` points local vite at **`https://agensis-backend.fly.dev`**.
So the dev server is not a sandbox:

- Data you see is **real production data**.
- Clicks that write (delete a workspace, send a message, remove an agent) hit
  **prod**. Look, don't touch. Never click a destructive control to "test" it.

## Known-benign console noise

Two `401`s on `/backend/system/capabilities` while logged out are **expected** —
it's the capabilities probe running before auth. Don't report them as a bug.

## Cleanup

Kill the dev server when done (`pkill -f "vite"` is too broad if other loops are
running — prefer killing the specific PID from the log). Screenshots land in the
session dir; they're scratch, don't commit them.

## Related

- `check-already-shipped` — verify the change is even still unmerged before you
  spin up a browser to look at it.
- `agensis-daemon-ops` — worktree isolation, and where human-uploaded screenshots
  land on disk (`~/Downloads`) when *they* show *you* something.
