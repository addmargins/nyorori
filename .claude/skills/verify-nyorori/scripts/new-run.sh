#!/usr/bin/env bash
# Creates one isolated verification run: a run directory (the evidence), the
# policies, and a throwaway git repository with a base commit and candidate
# branches. Prints the run directory on stdout and nothing else there, so
#   RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh [label])
# works. Progress goes to stderr. Two runs never share a repository, a work
# directory or a port, so they can proceed side by side.
#
# Throwaway repository (same shape as scripts/demo.mjs and test/e2e/cli.test.ts):
#   main   README.md, src/pricing.js applyDiscount with Cognitive Complexity 4, test/pricing.test.js
#   pass   applyDiscount grows to CogC 15 (the default limit)         -> PASS
#   fail   applyDiscount grows to CogC 16                             -> FAIL OVER_LIMIT
#   parse  adds src/broken.js that no parser accepts                  -> INCONCLUSIVE PARSE_ERROR_CANDIDATE
#   tdel   pass plus test/pricing.test.js deleted                     -> tests gate FAIL TEST_REMOVED (enforce policy)
# Policies (policy/default.policy.json with measurer.cccc_sha256 pinned to the binary in use):
#   policy.json           tests and coverage in observe mode: a code change can PASS without Actions artifacts
#   policy-enforce.json   the default modes (tests enforce): without artifacts a code change is REPORT_MISSING
#   policy-evidence.json  enforce plus one trusted workflow, for --artifacts runs (scripts/make-artifacts.sh)
#   policy-badpin.json    observe modes with a wrong sha256 pin: FINGERPRINT_MISMATCH
set -euo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

label="${1:-run}"
case "$label" in *[!A-Za-z0-9._-]*|"") die "label must match [A-Za-z0-9._-]+";; esac
[ -f "$CLI" ] || die "dist/cli.js is missing; run: npm run build"
cccc="$(resolve_cccc)" || die "no measurer; set NYORORI_CCCC (SKILL.md, Launch step 2)"
[ -x "$cccc" ] || die "$cccc is not executable"
cccc="$(cd "$(dirname "$cccc")" && pwd -P)/$(basename "$cccc")"

root="$(evidence_root)"
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$-$label"
mkdir -p "$root/$run_id/scratch/home" "$root/$run_id/scratch/work"
run="$(cd "$root/$run_id" && pwd -P)"
record_scratch "$run" "$run/scratch"
sha="$(sha256_of "$cccc")"
WF_SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

node - "$REPO_ROOT/policy/default.policy.json" "$sha" "$WF_SHA" "$run" <<'EOF'
const fs = require("node:fs");
const [src, sha, wfSha, run] = process.argv.slice(2);
const base = () => JSON.parse(fs.readFileSync(src, "utf8"));
const write = (name, p) => fs.writeFileSync(`${run}/${name}`, JSON.stringify(p, null, 2) + "\n");
let p = base(); p.measurer.cccc_sha256 = sha; p.tests.mode = "observe"; p.coverage.mode = "observe"; write("policy.json", p);
p = base(); p.measurer.cccc_sha256 = sha; write("policy-enforce.json", p);
p = base(); p.measurer.cccc_sha256 = sha;
p.provenance.trusted_workflows = [{ repository: "verify/gate", path: ".github/workflows/gate-untrusted-tests.yml", shas: [wfSha] }];
write("policy-evidence.json", p);
p = base(); p.measurer.cccc_sha256 = "0".repeat(64); p.tests.mode = "observe"; p.coverage.mode = "observe"; write("policy-badpin.json", p);
EOF

repo="$run/scratch/repo"
mkdir -p "$repo/src" "$repo/test"
# A function whose Cognitive Complexity is exactly $2: $2 flat `if`s at nesting 0.
fn() { printf 'export function %s(order, total) {\n' "$1"; local i; for ((i = 0; i < $2; i++)); do printf '  if (order.flag%d) total += %d;\n' "$i" "$i"; done; printf '  return total;\n}\n'; }
tgit "$repo" init -q -b main
printf 'verify-nyorori fixture repository\n' > "$repo/README.md"
fn applyDiscount 4 > "$repo/src/pricing.js"
printf 'import { applyDiscount } from "../src/pricing.js";\ntest("discount", () => { expect(applyDiscount({}, 1)).toBe(1); });\n' > "$repo/test/pricing.test.js"
tgit "$repo" add -A
tgit "$repo" commit -q -m "base: applyDiscount CogC 4, with a test"
BASE="$(tgit "$repo" rev-parse HEAD)"
tgit "$repo" checkout -q -b pass
fn applyDiscount 15 > "$repo/src/pricing.js"
tgit "$repo" commit -q -am "pass: applyDiscount CogC 15 (limit 15)"
PASS="$(tgit "$repo" rev-parse HEAD)"
tgit "$repo" checkout -q -b tdel
tgit "$repo" rm -q test/pricing.test.js
tgit "$repo" commit -q -m "tdel: delete the test"
TDEL="$(tgit "$repo" rev-parse HEAD)"
tgit "$repo" checkout -q -b fail "$BASE"
fn applyDiscount 16 > "$repo/src/pricing.js"
tgit "$repo" commit -q -am "fail: applyDiscount CogC 16 (limit 15)"
FAIL="$(tgit "$repo" rev-parse HEAD)"
tgit "$repo" checkout -q -b parse "$BASE"
printf 'function broken( {\n' > "$repo/src/broken.js"
tgit "$repo" add -A
tgit "$repo" commit -q -m "parse: add a file no parser accepts"
PARSE="$(tgit "$repo" rev-parse HEAD)"
tgit "$repo" checkout -q main
{
  echo "# throwaway repository $repo"
  tgit "$repo" log --all --graph --oneline --decorate
  echo
  for c in "$PASS" "$FAIL" "$PARSE" "$TDEL"; do tgit "$repo" show --stat --format='commit %H%n%s' "$c"; echo; done
} > "$run/repo.log"

cat > "$run/run.env" <<EOF
RUN_ID=$run_id
RUN_DIR=$run
REPO_ROOT=$REPO_ROOT
CLI=$CLI
CCCC=$cccc
CCCC_SHA256=$sha
SCRATCH=$run/scratch
WORKDIR=$run/scratch/work
REPO=$repo
BASE=$BASE
PASS=$PASS
FAIL=$FAIL
PARSE=$PARSE
TDEL=$TDEL
WF_SHA=$WF_SHA
POLICY=$run/policy.json
POLICY_ENFORCE=$run/policy-enforce.json
POLICY_EVIDENCE=$run/policy-evidence.json
POLICY_BADPIN=$run/policy-badpin.json
EOF
note "run $run_id ready; throwaway repo $repo (main $BASE)"
printf '%s\n' "$run"
