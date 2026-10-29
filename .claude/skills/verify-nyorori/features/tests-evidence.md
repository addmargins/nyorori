# Tests gate evidence (G4)

The tests gate (G4) needs the test report of the required Actions workflow to pass. Under an enforcing policy a code change without that report is INCONCLUSIVE (`REPORT_MISSING`), a deleted test is a FAIL (`TEST_REMOVED`) even without a report, and a report supplied with `--artifacts` counts only when its `provenance.json` names a workflow the policy trusts.

## Sub-features

- `g4-missing` enforcing policy, no artifacts: INCONCLUSIVE, exit 2, reason `REPORT_MISSING`, `### gate/tests: INCONCLUSIVE`.
- `g4-test-removed` a deleted test file: FAIL, exit 1, reasons `TEST_REMOVED` and `REPORT_MISSING`, `### gate/tests: FAIL`.
- `g4-proven` `--artifacts` with `tests.C.json` and a trusted `provenance.json`: tests gate PASS, verdict PASS, exit 0.
- `g4-untrusted` the same report without `provenance.json`: INCONCLUSIVE, exit 2, reason `UNTRUSTED_ARTIFACT`; the artifact can block, never pass.

## How to get to it (user POV)

- Run `node dist/cli.js run ... --policy <policy with tests.mode enforce>` with or without `--artifacts <dir>` where the dir has the required workflow's layout (`tests.C.json`, optional `tests.B.json`, `coverage/coverage-final.json`, `coverage-meta.json`, `mutation.json`, `metadata.json`, and locally a `provenance.json` stand-in).
- In production the service reads the same files from the trusted workflow's artifact and the run's provenance from the GitHub API; the local `--artifacts` path is the operator's replay of that evidence.

## Driving it with verify-nyorori

Preconditions:

- `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh g4)` and `.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` ended with `DOCTOR OK`.
- `policy-enforce.json` keeps the default `tests.mode: enforce`; `policy-evidence.json` adds `provenance.trusted_workflows` = `verify/gate` `.github/workflows/gate-untrusted-tests.yml` at sha `aaaa...a` (40 `a`), which `make-artifacts.sh` writes into `provenance.json`.

- **Missing report.** Judge `main -> pass` under the enforcing policy. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" g4-missing --expect INCONCLUSIVE --code 2 -- --base main --candidate pass --policy "$RUN/policy-enforce.json"`. The result line has `reasons=["REPORT_MISSING"]`; `$RUN/g4-missing/out/gate-summary.md` contains `### gate/tests: INCONCLUSIVE` and `- **REPORT_MISSING** candidate test report is missing`; `gates[]` in `quality-gate.json` lists `complexity`, `lint-structure`, `deps` as `PASS`.
- **Deleted test.** Judge `main -> tdel`. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" g4-removed --expect FAIL --code 1 -- --base main --candidate tdel --policy "$RUN/policy-enforce.json"`. The result line has `reasons=["TEST_REMOVED","REPORT_MISSING"]`; the summary contains `### gate/tests: FAIL` and `- **TEST_REMOVED** test removed: discount — \`test/pricing.test.js\``.
- **Proven report.** Build the artifact directory and judge with it. Run `ART=$(.claude/skills/verify-nyorori/scripts/make-artifacts.sh "$RUN" pass) && .claude/skills/verify-nyorori/scripts/gate.sh "$RUN" g4-proven --expect PASS --code 0 -- --base main --candidate pass --policy "$RUN/policy-evidence.json" --artifacts "$ART"`. The result line reads `g4-proven exit=0 state=PASS mergeAllowed=true authority=local reasons=[]`; `quality-gate.json` `gates[]` has `{"gate":"tests","mode":"enforce","state":"PASS"}` (coverage and mutation stay observe/INCONCLUSIVE); the summary has `### gate/tests: PASS`.
- **Untrusted report.** Same report, no provenance. Run `ART=$(.claude/skills/verify-nyorori/scripts/make-artifacts.sh "$RUN" pass --no-provenance) && .claude/skills/verify-nyorori/scripts/gate.sh "$RUN" g4-untrusted --expect INCONCLUSIVE --code 2 -- --base main --candidate pass --policy "$RUN/policy-evidence.json" --artifacts "$ART"`. The result line has `reasons=["UNTRUSTED_ARTIFACT","REPORT_MISSING"]` and `gates[]` shows tests as `MISSING` with `counted: false`.
- **Proof.** Keep `$RUN/artifacts-pass/` and `$RUN/artifacts-pass-noprov/` (the inputs) next to the four `result.txt` lines, then run `.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"`.

## Gotchas

- `provenance.json` is a local stand-in for what the service reads from the GitHub API; its `headSha` must be the candidate commit and `workflowSha` must be one of the policy's `trusted_workflows[].shas`, or the artifact is `UNTRUSTED_ARTIFACT`.
- `make-artifacts.sh` writes a report for exactly the throwaway repository's test (`test/pricing.test.js`, `discount`); a candidate that renames or deletes that test needs a different report, and the gate will say so.
- FAIL outranks INCONCLUSIVE in the aggregate: the deleted-test case exits 1 although the report is also missing.
- Coverage (G5) and mutation (G7) stay in observe mode in every run policy; their `INCONCLUSIVE (observe — 집계 제외)` lines are expected.
- `--artifacts` must be outside `--repo` like every other input; the helper's `artifacts-*` directories live in the run directory, not in scratch, so they survive cleanup as evidence.
