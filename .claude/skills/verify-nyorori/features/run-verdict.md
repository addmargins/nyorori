# Judge a change with `run`

`nyorori run` judges a candidate commit against a base commit of a git repository under a policy and the cccc measurer, prints a summary, exits 0/1/2 for PASS/FAIL/INCONCLUSIVE, and with `--out` writes the verdict, the per-gate results, the raw measurer output and the AI-loop feedback as files.

## Sub-features

- `run-pass` a change within the complexity limit is PASS with exit 0 and `mergeAllowed: true`.
- `run-fail` a function over the Cognitive Complexity limit is FAIL with exit 1 and reason `OVER_LIMIT`.
- `run-inconclusive` a file the measurer cannot parse is INCONCLUSIVE with exit 2 and reason `PARSE_ERROR_CANDIDATE`.
- `run-artifacts` `--out <dir>` writes `manifest.json`, `raw.B.json`, `raw.B.stderr`, `raw.C.json`, `raw.C.stderr`, seven `gate-result.<gate>.json`, `quality-gate.json`, `gate-summary.md`, `gate-feedback.json`.
- `run-authority` every CLI verdict carries `authority: "local"` and the summary's first line says so: a local result is not a merge approval.
- `run-in-process` `--in-process` gives the same verdict without the detached analysis worker (debugging path).

## How to get to it (user POV)

- Run `node dist/cli.js run --repo <dir> --base <rev> --candidate <rev> --policy <file.json> --cccc <bin> [--out <dir>]` in a terminal (or `nyorori run ...` when the package is installed).
- Read the exit code, the summary on stdout, and the files in `--out`.

## Driving it with verify-nyorori

Preconditions:

- `RUN=$(.claude/skills/verify-nyorori/scripts/new-run.sh verdict)` has printed a run directory, and `.claude/skills/verify-nyorori/scripts/doctor.sh "$RUN"` ended with `DOCTOR OK`.
- The throwaway repository has `main` (CogC 4), `pass` (CogC 15), `fail` (CogC 16) and `parse` (unparsable new file); `policy.json` keeps tests and coverage in observe mode so G1-G3 decide.

- **PASS.** Judge `main -> pass`. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" pass --expect PASS --code 0 -- --base main --candidate pass`. The result line reads `pass exit=0 state=PASS mergeAllowed=true authority=local reasons=[]` and the helper exits 0. `$RUN/pass/out/gate-summary.md` line 2 is `## quality-gate: PASS — 병합 허용`; `quality-gate.json` has `gates[]` with `complexity`, `lint-structure`, `deps` as `PASS`.
- **FAIL.** Judge `main -> fail`. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" fail --expect FAIL --code 1 -- --base main --candidate fail`. The result line reads `fail exit=1 state=FAIL mergeAllowed=false authority=local reasons=["OVER_LIMIT"]`. `$RUN/fail/out/gate-result.complexity.json` has one violation with `reason: "OVER_LIMIT"`, `unit: "src/pricing.js::applyDiscount#function[0]"`, `before: 4`, `after: 16`, `limit: 15`; the summary contains `### gate/complexity: FAIL` and a bullet starting `- **OVER_LIMIT** applyDiscount: CogC 16`.
- **INCONCLUSIVE.** Judge `main -> parse`. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" parse --expect INCONCLUSIVE --code 2 -- --base main --candidate parse`. The result line reads `parse exit=2 state=INCONCLUSIVE mergeAllowed=false authority=local reasons=["PARSE_ERROR_CANDIDATE"]`. `quality-gate.json` `inconclusive[]` names `src/broken.js` with `authorFixable: true`; `gates[]` shows `complexity` and `lint-structure` as `INCONCLUSIVE`.
- **Artifacts.** List what `--out` wrote. Run `ls "$RUN/fail/out"`. Exactly these fifteen names appear: `gate-feedback.json gate-result.complexity.json gate-result.coverage.json gate-result.deps.json gate-result.lint-structure.json gate-result.mutation.json gate-result.simplification-review.json gate-result.tests.json gate-summary.md manifest.json quality-gate.json raw.B.json raw.B.stderr raw.C.json raw.C.stderr`. `manifest.json` has `baseSha` and `candidateSha` equal to `BASE` and `FAIL` in `$RUN/run.env`; `gate-feedback.json` repeats them as `base_sha`/`candidate_sha` with `attempt: 1`.
- **Authority.** Read the stamp. Run `head -2 "$RUN/pass/out/gate-summary.md"; grep '"authority"' "$RUN/pass/out/quality-gate.json"`. Line 1 starts with `_authority: local` and the JSON has `"authority": "local"`.
- **In-process.** Repeat the PASS judgment without the worker. Run `.claude/skills/verify-nyorori/scripts/gate.sh "$RUN" pass-in-process --expect PASS --code 0 -- --base main --candidate pass --in-process`. Same state, same reasons; `diff <(jq -S 'del(.summary)' "$RUN/pass/out/quality-gate.json") <(jq -S 'del(.summary)' "$RUN/pass-in-process/out/quality-gate.json")` prints nothing when `jq` is available (otherwise compare `state`, `reasons` and `gates[]` by eye).
- **Proof.** Keep the run directory; quote `$RUN/pass/result.txt`, `$RUN/fail/result.txt`, `$RUN/parse/result.txt` and the `command.txt` next to each. Then run `.claude/skills/verify-nyorori/scripts/cleanup.sh "$RUN"` and confirm it prints `EVIDENCE KEPT`.

## Gotchas

- The summary prose is Korean (`병합 허용` allow, `병합 차단` block). Assert on `## quality-gate: <STATE>`, `### gate/<id>: <STATE>`, the reason codes and the JSON, not on the prose.
- `policy.json` observes tests and coverage, so their gates read `INCONCLUSIVE (observe — 집계 제외)` in every run; that is expected and not counted. Under `policy-enforce.json` the same code change is `INCONCLUSIVE/REPORT_MISSING` with exit 2 (see `tests-evidence.md`).
- The measurer must be pinned or allowed unpinned; `new-run.sh` pins its sha256. A policy with an empty `cccc_sha256` and enforcing gates is always `MEASURER_MISMATCH`.
- The worker path and `--in-process` differ only in process isolation; a verdict that differs between them is a finding, not noise.
- A syntax error inside an existing file that removes functions is judged FAIL (review required), not INCONCLUSIVE; use the `parse` branch for the INCONCLUSIVE path.
- `gate.sh` always passes `--workdir "$RUN/scratch/work"`. Without it `run` would use the shared `$TMPDIR/nyorori`.
