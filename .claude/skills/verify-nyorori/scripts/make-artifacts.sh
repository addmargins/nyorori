#!/usr/bin/env bash
# Writes a required-workflow artifact directory in the layout `nyorori run --artifacts`
# reads: a passing vitest JSON report for the throwaway repository's one test
# (test/pricing.test.js, "discount") and provenance.json naming the trusted workflow
# of policy-evidence.json with headSha = the candidate. --no-provenance leaves
# provenance.json out, which is how an artifact that cannot be attributed to the
# trusted workflow looks.
# Usage: .claude/skills/verify-nyorori/scripts/make-artifacts.sh <run-dir> <candidate-ref> [--no-provenance]
# Prints the directory: <run-dir>/artifacts-<ref>[-noprov] (kept as evidence).
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

load_run "${1:-}"
ref="${2:-}"; [ -n "$ref" ] || die "candidate ref is required (for example: pass)"
prov=1; [ "${3:-}" = "--no-provenance" ] && prov=0
sha="$(tgit "$REPO" rev-parse --verify "$ref^{commit}")"
dir="$RUN_DIR/artifacts-$ref"; [ "$prov" -eq 1 ] || dir="$dir-noprov"
mkdir -p "$dir"
cat > "$dir/tests.C.json" <<'EOF'
{"numTotalTests":1,"numPassedTests":1,"numFailedTests":0,"numPendingTests":0,"numTodoTests":0,"success":true,
 "testResults":[{"name":"test/pricing.test.js","status":"passed","assertionResults":[{"ancestorTitles":[],"title":"discount","fullName":"discount","status":"passed"}]}]}
EOF
if [ "$prov" -eq 1 ]; then
  cat > "$dir/provenance.json" <<EOF
{"repository":"verify/gate","workflowPath":".github/workflows/gate-untrusted-tests.yml","workflowSha":"$WF_SHA","runId":1,"runAttempt":1,"headSha":"$sha","event":"merge_group","runConclusion":"success"}
EOF
fi
note "artifacts for $ref ($sha): $dir"
printf '%s\n' "$dir"
