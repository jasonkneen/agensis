#!/usr/bin/env bash
# The green gate for one refactor step. Run it between every extraction.
#
# WHY THIS EXISTS, AND NOT JUST `npm run ci`
# ------------------------------------------
# `npm run ci 2>&1 | tail -6` reports the exit status of `tail`, not of npm — a
# pipeline's status is its LAST command's. A red lint at the end of the chain
# scrolls past the tail window and the caller reads "exit 0". That is exactly
# how commit 1654ef2 shipped an unused-import lint error while its gate said
# green. This script pipes nothing: it runs each stage, captures its real
# status, and exits non-zero if any stage failed.
#
# usage: bash scripts/refactor-gate.sh
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
LOG="${TMPDIR:-/tmp}/refactor-gate.$$.log"
FAILED=()

stage() {
  local name="$1"; shift
  printf '  %-14s ' "$name"
  if "$@" >>"$LOG" 2>&1; then
    printf 'ok\n'
  else
    printf 'FAILED\n'
    FAILED+=("$name")
  fi
}

echo "refactor gate — server/index.cjs is $(wc -l < server/index.cjs | tr -d ' ') lines"
echo

stage "syntax"    node --check server/index.cjs
stage "syntax:mcp" node --check server/mcp.cjs
stage "typecheck" npm run --silent typecheck
stage "test"      npm test
stage "test:unit" npm run --silent test:unit
stage "smoke"     npm run --silent smoke
stage "lint"      npm run --silent lint

echo
# The test COUNT must never fall: a suite that silently stops loading a file
# looks identical to one that passes. Compare against the recorded baseline.
COUNT=$(grep -Eo '^ℹ pass [0-9]+' "$LOG" | head -1 | grep -Eo '[0-9]+' || echo 0)
BASE_FILE="$(dirname "$0")/../.refactor-baseline"
if [ -f "$BASE_FILE" ]; then
  BASE=$(cat "$BASE_FILE")
  if [ "$COUNT" -lt "$BASE" ]; then
    echo "TEST COUNT REGRESSED: $COUNT (baseline $BASE) — a file stopped loading."
    FAILED+=("test-count")
  else
    echo "node tests: $COUNT (baseline $BASE)"
    [ "$COUNT" -gt "$BASE" ] && echo "$COUNT" > "$BASE_FILE"
  fi
else
  echo "$COUNT" > "$BASE_FILE"
  echo "node tests: $COUNT (baseline recorded)"
fi

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "GATE GREEN — safe to commit."
  rm -f "$LOG"
  exit 0
fi
echo "GATE RED — failed: ${FAILED[*]}"
echo "log: $LOG"
tail -30 "$LOG"
exit 1
