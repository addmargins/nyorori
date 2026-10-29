#!/usr/bin/env bash
# Tears down what one run created (its serve instance, throwaway repository and
# work directories) and keeps the evidence. Run it after every attempt, failed ones too.
# Usage: .claude/skills/verify-nyorori/scripts/cleanup.sh <run-dir>
# Removes only the paths listed in <run-dir>/scratch-paths.txt that live under
# <run-dir>/scratch. Never removes command/stdout/stderr/exit-code captures, out/
# directories, policies, run.env, repo.log or serve/ evidence. Exits 1 if the
# evidence did not survive.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_run "${1:-}"
if [ -f "$RUN_DIR/serve/serve.env" ]; then
  . "$RUN_DIR/serve/serve.env"
  if [ "${SERVE_PID:-0}" != 0 ] && [ -d "/proc/$SERVE_PID" ]; then "$(dirname "${BASH_SOURCE[0]}")/serve.sh" "$RUN_DIR" stop; fi
fi
if [ -f "$RUN_DIR/scratch-paths.txt" ]; then
  while read -r p; do
    [ -n "$p" ] || continue
    case "$p" in "$RUN_DIR"/scratch|"$RUN_DIR"/scratch/*) ;; *) note "refusing to remove $p: not under $RUN_DIR/scratch"; continue;; esac
    if [ -e "$p" ]; then rm -rf "$p"; echo "removed $p"; fi
  done < <(sort -u "$RUN_DIR/scratch-paths.txt")
fi
missing=0
for f in run.env policy.json repo.log; do [ -f "$RUN_DIR/$f" ] || { echo "EVIDENCE MISSING: $RUN_DIR/$f"; missing=1; }; done
echo "EVIDENCE KEPT: $RUN_DIR ($(find "$RUN_DIR" -type f | wc -l) files, $(du -sh "$RUN_DIR" | cut -f1))"
find "$RUN_DIR" -mindepth 2 -maxdepth 3 \( -name result.txt -o -name quality-gate.json -o -name requests.log \) | sort | sed 's/^/  /'
exit $missing
