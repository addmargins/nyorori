#!/usr/bin/env bash
# Replays the throwaway repository's (main -> pass) and (main -> fail) pairs with
# `nyorori replay` and captures the proof.
# Usage: .claude/skills/verify-nyorori/scripts/replay.sh <run-dir> [label]
# Captures <run-dir>/<label>/{pairs.json,command.txt,stdout.txt,stderr.txt,exit-code,result.txt,out/}.
# out/ holds replay-result.json, replay-summary.md and <id>/current/ with the same
# files as `run --out`. To replay other pairs, edit pairs.json and re-run command.txt.
# Exits 0 when replay exited 0 (no deltas, no errors), 1 otherwise.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_run "${1:-}"
label="${2:-replay}"
case "$label" in *[!A-Za-z0-9._-]*|.*|"") die "label must match [A-Za-z0-9_-][A-Za-z0-9._-]*";; esac
dir="$RUN_DIR/$label"; mkdir -p "$dir"
cat > "$dir/pairs.json" <<EOF
{ "schema_version": 1, "repository": "verify/fixture", "pairs": [
  { "id": "pass", "base": "$BASE", "candidate": "$PASS" },
  { "id": "fail", "base": "$BASE", "candidate": "$FAIL" } ] }
EOF
args=(replay --repo "$REPO" --pairs "$dir/pairs.json" --policy "$POLICY" --cccc "$CCCC" --out "$dir/out" --workdir "$SCRATCH/work-replay" --jobs 1)
write_command "$dir" "${args[@]}"
(cd "$REPO_ROOT" && node "$CLI" "${args[@]}") > "$dir/stdout.txt" 2> "$dir/stderr.txt"
rc=$?
echo "$rc" > "$dir/exit-code"
states="$(node -e 'const r=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(r.pairs.map(p=>p.id+"="+p.current.state).join(","))' "$dir/out/replay-result.json" 2>/dev/null || echo none)"
echo "$label exit=$rc pairs=$states :: $(head -1 "$dir/stdout.txt")" | tee "$dir/result.txt"
[ "$rc" -eq 0 ]
