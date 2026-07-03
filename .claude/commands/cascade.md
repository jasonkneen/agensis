---
description: Run a task through the model cascade — fable analyses, opus plans, sonnet executes, haiku assists, with an upward escalation ladder. Token-minimal .cf handoffs; humans read one line per stage.
---

Run the model cascade on this task: $ARGUMENTS

You are the orchestrator. You do not analyse, plan, or edit — you move `.cf` artifacts between tier-pinned subagents and keep the human informed with the stages' `HUMAN:` lines only. Do not add your own commentary between stages; the format is the product.

1. **Setup.** `mkdir -p cascade/esc cascade/logs`. Write the task verbatim to `cascade/00-task.txt`.

2. **Stage F.** Spawn `cascade-analyze` with: "Task file: cascade/00-task.txt. Produce cascade/10-findings.cf per your instructions." Surface its `HUMAN:` line to the user. If it emitted OPEN records, show those questions too and pause for answers before continuing (append answers to `00-task.txt`).

3. **Stage O.** Spawn `cascade-plan` with: "Findings: cascade/10-findings.cf. Produce cascade/20-plan.cf per your instructions." Surface its `HUMAN:` line.

4. **Stage S.** Spawn `cascade-execute` with: "Plan: cascade/20-plan.cf. Execute per your instructions; write cascade/30-changes.cf." Surface its `HUMAN:` line.

5. **Mediate S's results.** Subagents can't nest, so you route:
   - For each `st=deleg` CHG: spawn `cascade-assist` with only the delegated PLAN record(s) + payload(s), copied verbatim from `20-plan.cf`. Append its CHG records to `cascade/30-changes.cf`.
   - For each ESC record: write it plus its chained records (the PLAN item, its FIND — copy them verbatim, nothing else) to `cascade/esc/E<n>.cf`. Spawn the senior: `why=design-flaw|spec-conflict` → `cascade-analyze`; everything else from S → `cascade-plan`; ESCs from H → back to `cascade-execute`. Prompt: "Escalation: cascade/esc/E<n>.cf. Respond per your instructions." Passing only the records is the point — the senior NEEDs anything more, and you answer NEEDs by spawning `cascade-assist` to GIVE the extract.
   - Feed RES respecs back: append the new PLAN records to `cascade/esc/E<n>.cf`'s resolution and spawn `cascade-execute` again with just those items. `verdict=take` means the senior already did it — record its CHG and move on.
   - Repeat until `30-changes.cf` has no unresolved `st=blk|deleg`. Same item bouncing twice → allow the senior `verdict=take`.

6. **Meter.** The moment each Task completion notification arrives, capture its `total_tokens` and `duration_ms` — they aren't persisted anywhere else — and append an entry to `cascade/usage.json` (schema: the skill's `references/economics.md`): stage letter, the model from the tier map, `total_tokens`, `duration_ms`, `out_reported` from the stage's DONE `tok~=`, and the DONE counters. Escalation and deleg spawns get entries too (`escalations` array, with the senior's model and the ESC's `why` code). Set `baseline_model` once at the top (default `claude-opus-4-8`, or whatever single model the user would otherwise have used).

7. **Close.** Run the bundled cost report — locate the installed skill dir (e.g. `~/.claude/skills/cascade`) and:
   `python <skill-dir>/scripts/cascade_cost.py cascade/usage.json`
   This also appends the run to the cross-repo ledger (`~/.cascade/runs.jsonl`) and prints a lifetime line. Then report to the user: the final `HUMAN:` line, the DONE counters (ok/adapt/blk/deleg/esc), the artifact paths, the script's two savings lines — floor (fact-grade reprice) and modeled (counterfactual, multipliers shown) — and the lifetime line. One short paragraph, nothing more — the `.cf` files and `usage.json` are the full record for anyone (human or model) who wants depth. For fleet-wide efficiency across runs and repos, `python <skill-dir>/scripts/cascade_stats.py` any time.

Escalation ladder for reference: H → S → O → F, one tier per hop; design-flaw/spec-conflict jump straight to F; seniors answer with respecs, the originating tier acts.
