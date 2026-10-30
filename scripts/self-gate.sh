#!/usr/bin/env bash
# The gate judges its own repository: `nyorori run` on this checkout, base = the
# merge base with the target branch, candidate = HEAD, policy = policy/self.policy.json
# as it exists on the BASE side (a change cannot weaken the policy that judges it).
#
#   scripts/self-gate.sh [base-ref]      (default origin/main; NYORORI_CCCC must point at cccc)
#
# Exit codes are nyorori's: 0 PASS/N/A, 1 FAIL, 2 INCONCLUSIVE, 64 usage.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd -P)
base_ref=${1:-origin/main}
cccc=${NYORORI_CCCC:?set NYORORI_CCCC to the cccc binary}
base=$(git -C "$root" merge-base "$base_ref" HEAD)
head=$(git -C "$root" rev-parse HEAD)
tmp=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/nyorori-self-gate.XXXXXX")
trap 'rm -rf "$tmp"' EXIT
if ! git -C "$root" show "$base:policy/self.policy.json" > "$tmp/policy.json" 2>/dev/null; then
  cp "$root/policy/self.policy.json" "$tmp/policy.json"   # first run: the base predates the self policy
fi
# The gate refuses a measurer inside the repository it judges (CI builds cccc into .cccc-bin/).
cp "$cccc" "$tmp/cccc" && chmod 0755 "$tmp/cccc"
[ -f "$root/dist/cli.js" ] || (cd "$root" && npx tsc -p tsconfig.build.json)
set +e
node "$root/dist/cli.js" run --repo "$root" --base "$base" --candidate "$head" --policy "$tmp/policy.json" \
  --cccc "$tmp/cccc" --out "$tmp/out" --runner-commit "$head"
code=$?
set -e
cat "$tmp/out/gate-summary.md" 2>/dev/null || true
if [ -n "${GITHUB_STEP_SUMMARY:-}" ] && [ -f "$tmp/out/gate-summary.md" ]; then cat "$tmp/out/gate-summary.md" >> "$GITHUB_STEP_SUMMARY"; fi
exit $code
