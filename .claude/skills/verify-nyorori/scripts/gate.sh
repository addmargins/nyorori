#!/usr/bin/env bash
# Drives one `nyorori run` exactly as a user would and captures the proof.
# Usage:
#   .claude/skills/verify-nyorori/scripts/gate.sh <run-dir> <label> [--expect <STATE|USAGE>] [--code <n>] [--raw] -- <nyorori run args>
# Default mode appends to your args:
#   --policy <run-dir>/policy.json   (only when you pass no --policy)
#   --repo <throwaway repo> --cccc <measurer> --workdir <run-dir>/scratch/work --out <run-dir>/<label>/out
# --raw appends only --cccc and --workdir (each only when absent); you supply --repo, --policy and --out
#   yourself. Use it for usage errors and the path guard.
# Captures <run-dir>/<label>/{command.txt,stdout.txt,stderr.txt,exit-code,result.txt} plus out/ when written.
# Prints the result line. Exits 0 when the observed state and exit code match --expect/--code
# (or none were given), 1 on a mismatch. STATE is PASS, FAIL, INCONCLUSIVE, NOT_APPLICABLE,
# ACCEPTED_WITH_WAIVER, or USAGE for exit 64 with no verdict.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_run "${1:-}"; shift
label="${1:-}"; [ -n "$label" ] || die "label argument is required"; shift
case "$label" in *[!A-Za-z0-9._-]*|.*) die "label must match [A-Za-z0-9_-][A-Za-z0-9._-]*";; esac
expect=""; code=""; raw=0
while [ $# -gt 0 ]; do
  case "$1" in
    --expect) expect="${2:-}"; shift 2;;
    --code) code="${2:-}"; shift 2;;
    --raw) raw=1; shift;;
    --) shift; break;;
    *) die "unknown option $1 (nyorori run arguments go after --)";;
  esac
done
args=("$@")
has() { local a; for a in "${args[@]}"; do [ "$a" = "$1" ] && return 0; done; return 1; }

dir="$RUN_DIR/$label"; mkdir -p "$dir"
if [ "$raw" -eq 0 ]; then
  has --policy || args+=(--policy "$POLICY")
  args+=(--repo "$REPO" --cccc "$CCCC" --workdir "$WORKDIR" --out "$dir/out")
else
  has --cccc || args+=(--cccc "$CCCC")
  has --workdir || args+=(--workdir "$WORKDIR")
fi
write_command "$dir" run "${args[@]}"
(cd "$REPO_ROOT" && node "$CLI" run "${args[@]}") > "$dir/stdout.txt" 2> "$dir/stderr.txt"
rc=$?
echo "$rc" > "$dir/exit-code"

state=""; merge=""; authority=""; reasons=""
verdict=""
for v in "$dir/out/quality-gate.json"; do [ -f "$v" ] && verdict="$v"; done
if [ -z "$verdict" ] && has --out; then
  i=0; for a in "${args[@]}"; do i=$((i + 1)); [ "$a" = "--out" ] && { [ -f "${args[$i]}/quality-gate.json" ] && verdict="${args[$i]}/quality-gate.json"; }; done
fi
if [ -n "$verdict" ]; then
  read -r state merge authority reasons < <(node -e 'const v=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));console.log(v.state,v.mergeAllowed,v.authority,JSON.stringify(v.reasons))' "$verdict")
elif grep -q '^## quality-gate: ' "$dir/stdout.txt"; then
  state="$(sed -n 's/^## quality-gate: \([A-Z_]*\).*/\1/p' "$dir/stdout.txt" | head -1)"
  grep -q '^_authority: local' "$dir/stdout.txt" && authority=local
elif [ "$rc" -eq 64 ]; then
  state=USAGE
fi
line="$label exit=$rc state=${state:-none} mergeAllowed=${merge:--} authority=${authority:--} reasons=${reasons:--} stderr=\"$(head -c 200 "$dir/stderr.txt" | tr '\n' ' ')\""
printf '%s\n' "$line" | tee "$dir/result.txt"
bad=0
if [ -n "$expect" ] && [ "$expect" != "$state" ]; then echo "MISMATCH: expected state $expect, observed ${state:-none}"; bad=1; fi
if [ -n "$code" ] && [ "$code" != "$rc" ]; then echo "MISMATCH: expected exit $code, observed $rc"; bad=1; fi
exit $bad
