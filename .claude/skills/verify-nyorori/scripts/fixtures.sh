#!/usr/bin/env bash
# Runs `nyorori fixtures` (the measurer against the calculation-rule fixtures) and captures the proof.
# Usage: .claude/skills/verify-nyorori/scripts/fixtures.sh <run-dir> [--tamper]
#   default   the tracked test/fixtures/cccc-rules: expect "<N> fixtures, 0 drift(s)" and exit 0
#   --tamper  a scratch copy with one expected value changed (if.ts cognitive +1):
#             expect a "DRIFT if.ts" block, "<N> fixtures, 1 drift(s)" and exit 1
# Captures <run-dir>/fixtures[-tamper]/{command.txt,stdout.txt,stderr.txt,exit-code,result.txt}.
# Exits 0 when the observation matches the expectation above, 1 otherwise.
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_run "${1:-}"
tamper=0; [ "${2:-}" = "--tamper" ] && tamper=1
label=fixtures; args=(fixtures --cccc "$CCCC")
if [ "$tamper" -eq 1 ]; then
  label=fixtures-tamper
  copy="$SCRATCH/fixtures-tampered"; rm -rf "$copy"; cp -r "$REPO_ROOT/test/fixtures/cccc-rules" "$copy"
  node -e 'const fs=require("node:fs");const f=process.argv[1];const e=JSON.parse(fs.readFileSync(f,"utf8"));e["if.ts"].functions[0][3]+=1;fs.writeFileSync(f,JSON.stringify(e,null,2));' "$copy/expected.json"
  args+=(--dir "$copy")
fi
dir="$RUN_DIR/$label"; mkdir -p "$dir"
write_command "$dir" "${args[@]}"
(cd "$REPO_ROOT" && node "$CLI" "${args[@]}") > "$dir/stdout.txt" 2> "$dir/stderr.txt"
rc=$?
echo "$rc" > "$dir/exit-code"
drift=""; [ "$tamper" -eq 1 ] && drift=" / $(grep -m1 '^DRIFT' "$dir/stdout.txt")"
echo "$label exit=$rc: $(tail -1 "$dir/stdout.txt")$drift" | tee "$dir/result.txt"
if [ "$tamper" -eq 0 ]; then
  [ "$rc" -eq 0 ] && grep -Eq '^[0-9]+ fixtures, 0 drift\(s\)$' "$dir/stdout.txt"
else
  [ "$rc" -eq 1 ] && grep -q '^DRIFT if.ts$' "$dir/stdout.txt"
fi
