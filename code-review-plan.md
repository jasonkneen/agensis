# Code review remediation — 2026-09-04

Scope: fix the confirmed findings in the current checkout; preserve the existing
theme changes. Implementation workers use GPT-5.6 Luna. The supervising agent
reviews diffs, resolves integration issues, and runs the complete local checks.
No deployment or publication is part of this task.

## 1. Authentication and administrative boundaries

- [x] Reject exhausted sign-in budgets before password verification on both backends.
- [x] Protect the System workspace flag and verify its owner before routing feedback.
- [x] Make all membership mutation lanes produce privileged-action audit records.
- [x] Remove custom gateway credentials from read-role responses.

Administrative validation: 75 focused tests passed. Generic and dedicated
membership UPDATE queries also passed against an isolated PostgreSQL 14.20
cluster, verifying old/new roles, narrow response projections and workspace
mismatch behavior. The temporary cluster was stopped after validation.

## 2. Realtime, event routing, and execution

- [x] Prevent nested subscription fields from overriding the authorized channel.
- [x] Exclude private conversations from workspace-wide Flows and automation events.
- [x] Preserve streamed answers across content-free daemon heartbeats.
- [x] Apply automation execution limits after evaluating conditions, with bounded reads.

Event validation: 113 focused tests passed, including socket authorization,
private-event delivery suppression, empty-heartbeat finalization, segment
rotation and matching rules on later database pages. Known private sources are
discarded; inconclusive privacy lookups retry without discarding their payload.

## 3. Account, workspace, and transcript state

- [x] Fence memory facts and their pending requests by workspace identity.
- [x] Reset workspace state and pending requests on authenticated-account changes.
- [x] Prevent pending reads from overwriting redacted offline transcript caches.
- [x] Recheck revocation before applying earlier-message pages.

State validation: 25 focused tests passed, including account-provider remounting
and revocation while an earlier transcript page is in flight. Typecheck and
changed-file lint passed.

## 4. Document and mutation correctness

- [x] Keep autosave timers separate for each document.
- [x] Refresh open editors on remote body changes without discarding local edits.
- [x] Preserve documents, tasks, and memory facts when deletion is rejected.

Document validation: 13 focused mutation/editor tests passed. Pending saves
retain their scheduling authorization; changing accounts prevents an old edit
from being submitted as the new account. Workspace-only switches flush pending
saves while authorization remains unchanged. Rejected deletions keep the editor
open and show an error instead of writing a success activity entry.
Editors hand edits to the hook immediately; the hook owns the sole persistence
debounce, so closing an editor does not abandon an edit in a second timer.

## 5. Uploads, local Git, and publication checks

- [x] Serve XML uploads without executable browser semantics.
- [x] Prevent Git pathspec magic from escaping the allowed project root.
- [x] Consume both path records when parsing Git renames.
- [x] Preserve the tracked conversation export in a local ignored archive.

Local fixes: 21 upload/Git regression tests and 13 publication checks passed.
The transcript is preserved at `review-archive.local/status-latest-2026-09-04.md`,
covered by the existing `*.local` ignore rule.

## Validation

Each fix needs a focused behavioral regression test. Workers run their owned
tests and report the commands and results. The supervisor reviews security
boundaries and runs typecheck, backend tests, voice tests, frontend unit tests,
smoke tests, lint, and the production build. Test fixtures must remain isolated
from live credentials and databases. Any remaining limitations are reported.

Baseline: typecheck passed; 3,163 frontend tests and 19 smoke tests passed;
backend tests had 2,832 passes, three publication-hygiene failures, and two skips;
lint had zero errors and 32 warnings.

Final verification:

| Check | Result |
| --- | --- |
| `npm run ci` | Passed |
| TypeScript | Passed |
| Backend | 2,852 passed; 2 optional database integration tests skipped |
| Voice worker | 45 passed |
| Frontend unit tests | 3,182 passed across 245 files |
| Smoke tests | 19 passed |
| ESLint | 0 errors; 32 existing warnings |
| `npm run build` | Passed |
| Final automation ordering regression | 45 passed |
| `git diff --check` | Passed |

The final automation query orders by the typed database timestamp while carrying
its full-precision text value in the pagination cursor. The focused automation
suite passed after that final adjustment.

An isolated browser exercise confirmed XML uploads are returned as attachments
with `application/octet-stream`. Isolated real Git repositories verified literal
path handling and rename parsing. The archived transcript is byte-identical to
the original tracked file, and the pre-existing theme changes remain untouched.
No deployment, staging, or commit was performed.
