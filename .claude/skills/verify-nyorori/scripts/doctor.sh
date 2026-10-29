#!/usr/bin/env bash
# Read-only: is this checkout worth driving? Prints a report ending in
# "DOCTOR OK" (exit 0) or "DOCTOR FAIL" (exit 1).
# Usage: .claude/skills/verify-nyorori/scripts/doctor.sh [run-dir]
#   With a run dir, the same report is also written to <run-dir>/doctor.txt.
# Checks: node >= 22, git, dist/cli.js runs and is newer than src/, the cccc
# measurer resolves and reports "cccc 1.8.5", and `nyorori fixtures` finds no
# drift (reads test/fixtures/cccc-rules, writes nothing into the repository).
set -uo pipefail
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

out=/dev/null
if [ $# -ge 1 ]; then [ -d "$1" ] || die "$1 is not a directory"; out="$(cd "$1" && pwd -P)/doctor.txt"; : > "$out"; fi
fail=0
report() { printf '%s\n' "$*" | tee -a "$out"; }
ok() { report "ok    $*"; }
bad() { fail=1; report "FAIL  $*"; }

report "verify-nyorori doctor $(date -u +%Y-%m-%dT%H:%M:%SZ)"
report "repo  $REPO_ROOT"

if command -v node >/dev/null 2>&1; then
  v="$(node --version)"; major="${v#v}"; major="${major%%.*}"
  if [ "$major" -ge 22 ] 2>/dev/null; then ok "node $v"; else bad "node $v is older than 22 (package.json engines)"; fi
else bad "node is not on PATH"; fi
if command -v git >/dev/null 2>&1; then ok "git $(git --version | cut -d' ' -f3)"; else bad "git is not on PATH"; fi

if [ -f "$CLI" ]; then
  if node "$CLI" --help >/dev/null 2>&1; then ok "dist/cli.js runs (--help exits 0)"; else bad "node dist/cli.js --help failed; run: npm run build"; fi
  newer="$(find "$REPO_ROOT/src" -type f -newer "$CLI" 2>/dev/null | head -1)"
  if [ -n "$newer" ]; then report "warn  src is newer than dist/cli.js (${newer#"$REPO_ROOT"/}); run npm run build before trusting a verdict"; else ok "dist/cli.js is newer than every file in src/"; fi
else bad "dist/cli.js is missing; run: npm ci && npm run build"; fi

cccc=""
if cccc="$(resolve_cccc)"; then
  if [ -x "$cccc" ]; then
    ver="$("$cccc" --version 2>/dev/null || true)"
    if [ "$ver" = "$CCCC_EXPECTED_VERSION" ]; then ok "cccc $cccc reports '$ver'"; else bad "cccc $cccc reports '$ver'; the policies pin '$CCCC_EXPECTED_VERSION'"; fi
    sha="$(sha256_of "$cccc")"
    if [ "$sha" = "$CCCC_RELEASE_BINARY_SHA256" ]; then ok "cccc sha256 $sha is the v1.8.5 release pin"; else report "warn  cccc sha256 $sha is not the v1.8.5 release pin (source build?); verification policies pin this hash, so runs still work, but never pin it in a real policy"; fi
  else bad "cccc $cccc is not executable"; fi
else bad "no measurer: set NYORORI_CCCC or install it at .nyorori-work/cccc-v1.8.5/cccc (SKILL.md, Launch step 2)"; fi

if [ "$fail" -eq 0 ]; then
  fx="$(cd "$REPO_ROOT" && node "$CLI" fixtures --cccc "$cccc" 2>&1)"; code=$?
  last="$(printf '%s\n' "$fx" | tail -1)"
  if [ "$code" -eq 0 ] && printf '%s' "$last" | grep -Eq '^[0-9]+ fixtures, 0 drift\(s\)$'; then ok "fixtures: $last"; else bad "fixtures exit $code: $(printf '%s\n' "$fx" | tail -3 | tr '\n' ' ')"; fi
fi

report "evidence root $(evidence_root)"
if [ "$fail" -eq 0 ]; then report "DOCTOR OK"; exit 0; else report "DOCTOR FAIL"; exit 1; fi
