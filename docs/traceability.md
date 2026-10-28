# Spec traceability matrix

Maps every acceptance row of `docs/SPEC.md` §14, every §6.3 check, the §9.1 state rules,
§10.2 vectors V1–V19 and the §12.2 forbidden list to the implementing module(s) and the
test(s) that prove it. Rulings in `docs/debate/rulings.md` override the spec.

Baseline: commit `a49fc18`, full suite 805/805 passing with cccc 1.8.5
(`/home/user/moznion/cccc/target/release/cccc`), `npm run typecheck` clean.
Test references are `file :: test name` (vitest full name, describe prefix shortened when
unambiguous). Legend: ✅ covered by a named test · ⚠️ partial (see note) · ❌ no test ·
↪ Dn changed by ruling Dn (↪ Fn / #n: by an audit or security-review disposition).

Path abbreviations: `cx` = `src/gates/complexity/evaluate.ts`, `lint` = `src/gates/lint/`,
`deps` = `src/gates/deps/`, `tg` = `src/gates/tests/`, `agg` = `src/aggregate/index.ts`.

## 1. SPEC §14 acceptance criteria

### 재현성 (reproducibility)

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.1 | Same B/C/P/M repeated → identical normalized verdict and evidence | ❌ | `src/pipeline/run.ts` (no time/run-id fields in `GateResult`) | None. A manual probe (two `runGates` calls on one FAIL scenario) gave byte-identical results, verdict, feedback and summary, but no test pins it. |
| 14.2 | `-j1` vs `-j4` → byte-identical | ✅ | `src/measure/cccc.ts` (`runCccc` `jobs`), `src/measure/measure.ts` (5% `-j1` re-run → `NONDETERMINISM`) | `test/measure/cccc-rules.test.ts :: … produces byte-identical output with -j1 and -j4`; `test/measure/measure.test.ts :: measureSides end to end measures B and C, keyed by repository path, with a determinism re-run` |
| 14.3 | §3.3 calculation rules match the table | ✅ | `test/fixtures/cccc-rules/expected.json`, `src/fixtures/rules.ts`, `src/cli.ts` (`fixtures`) | `test/measure/cccc-rules.test.ts` (one test per fixture, e.g. `… logical-assign.ts`, `… covers every fixture file on disk`); `test/e2e/cli.test.ts :: nyorori CLI checks the calculation-rule fixtures against the binary` |

### 정책 (policy)

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.4 | New unit CogC 15 / 16 → PASS / FAIL | ✅ | `cx` | `test/complexity/decision.test.ts :: spec 5.3 decision table new 15 PASS / new 16 FAIL OVER_LIMIT_NEW`; `test/e2e/gates.test.ts :: G1 complexity end to end new unit: CogC 15 passes, 16 fails with OVER_LIMIT_NEW` |
| 14.5 | Existing unit under the limit grows within budget → PASS | ✅ | `cx` | `decision.test.ts :: spec 5.3 decision table existing 10→14 PASS, 10→17 FAIL OVER_LIMIT` |
| 14.6 | Existing unit over 15, +1 → FAIL | ✅ | `cx` | `decision.test.ts :: … legacy 22→23 FAIL LEGACY_WORSENED; 22→18 PASS + S5`; `gates.test.ts :: … legacy unit over the limit: +1 fails, untouched legacy in a changed file passes without S5` |
| 14.7 | Unrelated edit; legacy over-limit unit in the same file is out of range → no FAIL, no S5 | ✅ | `cx` (`s5Triggers`, range test via `src/git/linemap.ts` `cRangeTouched`) | `decision.test.ts :: … an untouched legacy unit in a changed file never fails and fires no S5`; `test/complexity/regressions.test.ts :: S5 range edges (audit-spec s5 repro) insert between… / edit the next unit… / append at EOF…` |
| 14.8 | Only a nested callback over the limit → FAIL | ✅ | `src/units/model.ts`, `cx` | `decision.test.ts :: spec 14 policy rows a nested callback over the limit fails on its own` |
| 14.9 | Logic moved to top level / `static {}` / field initializer → judged as `<module>` | ✅ | `src/units/model.ts` (residue), `cx` | `decision.test.ts :: spec 14 policy rows logic at module level, in static {} or a field initializer is judged as <module>`; `test/complexity/manipulation.test.ts :: … (e) fails on the module residue, not on a function` |
| 14.10 | CC ≥ 20, CogC ≤ 15 → PASS, CC observed | ✅ | `cx` | `decision.test.ts :: spec 14 policy rows CC ≥ 20 with CogC ≤ 15 passes and is observed` |

### 대응 (unit matching)

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.11 | Rename, file move, line move → inherit only provable identity; line numbers alone never create debt | ✅ | `src/units/match.ts` (stages 1–4), `src/units/body.ts` | `test/complexity/match.test.ts :: matchUnits stage 1: a line shift keeps the legacy allowance and fires no S5`, `… stage 2: in-place rename…`, `… stage 3: reordering functions…`, `… stage 4: a verbatim move to a new file keeps the allowance`, `… stage 4 refuses a move whose score changed`; `regressions.test.ts :: F4: a stage-4 move needs an identical body to skip S5 …` (↪ F4) |
| 14.12 | Duplicate a legacy high-complexity function → copies do not share one allowance | ✅ | `src/units/match.ts` | `match.test.ts :: matchUnits duplicating legacy debt: the copy gets the new-unit limit`, `… a copied file (status C) never inherits`; `test/e2e/acceptance.test.ts :: legacy allowance inherited through a rename a copy of a legacy unit under a new name gets the new-code limit` |
| 14.13 | Same-name methods in different classes, same-line anonymous functions, overload signatures → no arbitrary inheritance; over budget → `UNMATCHED_OVER_BUDGET` | ✅ ↪ D21 | `src/units/match.ts` (D21a ordinal on Prettier-identical files, D21b k-to-k by CogC with S5) | `match.test.ts :: matchUnits D21b: a k-to-k group of same-name methods in one hunk pairs by CogC and is identity-changed`, `… same-line anonymous functions: line ordinal when untouched, k-to-k when the line is edited`, `… overload signatures shift without stealing the implementation's allowance`; `decision.test.ts :: … unmatched legacy-sized unit: FAIL UNMATCHED_OVER_BUDGET with B candidates`; `regressions.test.ts :: D21a: normalized-identical files match by ordinal …`; `regressions.test.ts :: F1 / bug #1: unit keys cannot collide through string-literal names …` |
| 14.14 | Name kept, whole body of a >15 unit replaced → `S5(identity-changed)` | ✅ | `src/units/match.ts`, `cx` (`s5Triggers`) | `match.test.ts :: matchUnits body replaced, declaration untouched: matched at stage 1 but S5 fires on the range`; `acceptance.test.ts :: … renaming a legacy unit while rewriting its body routes S5 identity-changed` |
| 14.15 | Name changed to a confusable → new, with warning | ✅ | `src/units/names.ts` (NFKC + confusables), `src/units/match.ts` | `match.test.ts :: names normalizes full-width forms with NFKC and flags look-alikes`, `… a rename onto a Cyrillic look-alike is treated as new, with a warning`, `… a look-alike name never matches by unique name or verbatim move` |

### 측정 무결성 (measurement integrity)

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.16 | C syntax error or >1000-level nesting (exit 0, 0/0) → INCONCLUSIVE `PARSE_ERROR_CANDIDATE`, not overridable | ⚠️ ↪ F5 | `src/measure/cccc.ts` (`validateCcccRun`), `src/override/index.ts` | Syntax error: `test/measure/measure.test.ts :: measureSides end to end C-side syntax error is INCONCLUSIVE and author-fixable; B-side syntax error removes the baseline`; `gates.test.ts :: … a candidate syntax error is INCONCLUSIVE, never a pass, and its check fails`; `test/platform/override.test.ts :: measurement override rejects non-owners, the author, changed files and author-fixable reasons`. Parser-lag exception (F5): `override.test.ts :: … allows PARSE_ERROR_CANDIDATE only for listed parser-lag syntax`; `test/measure/round2.test.ts :: parser lag (audit F5) …`. **Gap:** no fixture or test for the >1000-level nesting case. |
| 14.17 | B syntax error → that file's C units are judged new | ✅ | `src/measure/cccc.ts` (`baselineParseErrors`), `src/measure/measure.ts` (`baselineMissing`), `src/units/match.ts` | `test/measure/validate.test.ts :: … B-side parse errors only remove the baseline`; `match.test.ts :: matchUnits B parse error: every C unit is new and no B unit is offered as an origin`; `measure.test.ts` (as 14.16) |
| 14.18 | Non-UTF-8 file → INCONCLUSIVE `MANIFEST_MISMATCH` | ✅ ↪ F15 | `src/measure/cccc.ts` (`encodingSkips`) | `measure.test.ts :: measureSides end to end non-UTF-8 candidate file is INCONCLUSIVE and author-fixable` (asserts `MANIFEST_MISMATCH`); B side only drops the baseline: `test/measure/round2.test.ts :: unreadable baseline (audit F15) a non-UTF-8 B side only removes the baseline; its C units are new`; `test/measure/cccc-rules.test.ts :: cccc 1.8.5 I/O behaviour … skips a non-UTF-8 file: missing from files[], reported on stderr, exit 0` |
| 14.19 | No matching file (empty stdout) → N/A when the manifest is empty, else INCONCLUSIVE | ✅ | `src/measure/cccc.ts` (`EMPTY_OUTPUT`), `src/pipeline/service-gates.ts` (`hasMeasuredCode`) | `validate.test.ts :: … EMPTY_OUTPUT when the manifest is non-empty but stdout is empty`, `… no files expected and no output is not a problem`; `gates.test.ts :: scope and applicability a docs-only PR is NOT_APPLICABLE …` |
| 14.20 | Docs-only change → NOT_APPLICABLE with the reason recorded | ⚠️ | `src/pipeline/service-gates.ts`, `src/pipeline/actions-gates.ts`, `agg` | `gates.test.ts :: scope and applicability a docs-only PR is NOT_APPLICABLE and merge-allowed, even with tests enforced`; `test/platform/aggregate.test.ts :: quality-gate aggregation all N/A gives N/A (docs-only PR still reports)`. **Gap:** no test asserts a recorded reason; a `GateResult` has no N/A reason field (the summary is just "N/A"). |
| 14.21 | Valid declaration file with zero functions → does not fail for having zero units | ✅ | `src/git/manifest.ts` (`.d.ts` measured when `declaration_impl_check`, excluded `DECLARATION_FILE` otherwise), `src/measure/cccc.ts` (ambient-context parse error → `PARSE_ERROR_CANDIDATE`) | `test/git/manifest.test.ts :: pure helpers classifyPath follows the policy order`, `… routes unsupported formats, excluded paths, declarations, foreign and unknown extensions`; `test/measure/measure.test.ts :: … a clean .d.ts is measured with no error; an implementation inside is an author-fixable PARSE_ERROR_CANDIDATE`; `gates.test.ts :: … an implementation hidden in a .d.ts file is INCONCLUSIVE`. |
| 14.22 | A file with many units drops to 0 units → INCONCLUSIVE `UNITS_VANISHED` | ✅ | `src/measure/measure.ts` (`unitsVanished`) | `measure.test.ts :: measureSides end to end UNITS_VANISHED when a file with many units keeps its size but loses every unit`; `decision.test.ts :: triggers S11 unit vanish; UNITS_VANISHED is left to measure.ts (bug #11)` |
| 14.23 | `foo.js` (JSX) next to `foo.jsx` → suffix conversion, no collision | ✅ | `src/git/manifest.ts` (measured-path suffix), `src/git/tree.ts` (`materializeSideChecked`) | `manifest.test.ts :: … gives JSX-in-.js files a .jsx measured path that does not collide with a real .jsx`; `measure.test.ts :: … measures JSX-in-.js through the .jsx suffix and reports by repository path`; `test/git/round2.test.ts :: case collisions (audit F16, bug #5) a .jsx suffix colliding with a real file is INCONCLUSIVE, not a crash` |
| 14.24 | Two paths differing only in case → INCONCLUSIVE | ✅ ↪ F16, #9 | `src/git/manifest.ts` (`foldPathForCollision`, full C tree) | `manifest.test.ts :: … detects LFS pointers, oversize blobs and case collisions`; `test/git/round2.test.ts :: case collisions (audit F16, bug #5) checks the candidate's full tree, not only changed files`; `test/git/round3.test.ts :: normalization-insensitive collisions (security review #9) …` |
| 14.25 | Two reports with different measurement fingerprints → refuse to compare, re-measure | ✅ | `agg` (`FINGERPRINT_MISMATCH`), `src/measure/fingerprint.ts` | `aggregate.test.ts :: quality-gate aggregation rejects results with another B/C/P/M`. Re-measurement is the service's next evaluation (no separate test). |

### 우회 (bypass)

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.26 | PR narrows scope with `cccc.toml` / `.cccc.toml` / `.ignore` → official scope and policy unchanged | ⚠️ | `src/measure/fingerprint.ts` (`--no-config --no-cache`), `src/git/manifest.ts` (explicit file list from policy) | `cccc.toml`: `measure.test.ts :: measureSides end to end ignores a candidate cccc.toml that excludes everything`; `gates.test.ts :: … a PR-supplied cccc.toml excluding src/** cannot hide an over-limit unit`; `manifest.test.ts :: … ignores repository-level attributes and configs: classification comes from policy only`. **Gap:** no test uses `.cccc.toml` or `.ignore` (same mechanism, untested). |
| 14.27 | PR adds `working-tree-encoding` in `.gitattributes` → measurement unchanged (blob trees), S11, CODEOWNERS review | ✅ ↪ D1 | `src/git/tree.ts`, `src/git/manifest.ts` (`sensitivePathsChanged`), `cx` (`s11Triggers`) | `gates.test.ts :: … .gitattributes working-tree-encoding does not change measurement and routes S11 to review`; `measure.test.ts :: … still measures every .ts after the candidate adds a UTF-16 working-tree-encoding attribute`, `tree materialization writes blob bytes exactly, ignoring working-tree-encoding in .gitattributes`. D1: the gate does not rely on CODEOWNERS; the change routes S11 to G6. |
| 14.28 | `.ts` moved to `.vue` / an unregistered extension / an excluded path / a symlink → S11 or INCONCLUSIVE, never an automatic pass | ✅ ↪ D5 | `src/git/manifest.ts`, `cx` (`s11Triggers`), `deps/targets.ts` (imports of unmeasured files) | `gates.test.ts :: … moving code to an unmeasured .vue file routes S11 instead of passing silently`; `manifest.test.ts :: … marks symlinks, submodules and type changes unmeasured`, `… routes unsupported formats, excluded paths, declarations, foreign and unknown extensions`; `decision.test.ts :: triggers S11: unmeasured entries, new files in excluded paths, sensitive paths`; `regressions.test.ts :: D5: foreign-language files …`. D5: an unknown extension routes S11 instead of INCONCLUSIVE. |
| 14.29 | Body moved into `new Function` / `Object.constructor.constructor` / `Reflect.construct(Function, …)` → G2 FAIL, S11 | ✅ | `lint/rules/dynamic-code.ts`, `cx` (S11 unit vanish) | `test/lint/rules.test.ts :: dynamic code (block, spec 7.2 i / V17) new Function`, `… Object.constructor.constructor`, `… Reflect.construct(Function)`; `test/lint/variants.test.ts :: spec 7.2 rewrites i: Function constructor`, `… V17: Object.constructor.constructor`; `manipulation.test.ts :: … (i) vanish: the bound name survives, so S11 fires` |
| 14.30 | `new Function` added under an `/* eslint-disable */` that already existed in B → G2 FAIL (`--no-inline-config`) | ✅ | `lint/run.ts`, `lint/config.ts` | `test/lint/evaluate.test.ts :: new-violation rule FAILs on new Function added under a base-branch /* eslint-disable */ (spec 14)`; `gates.test.ts :: G2 lint end to end new Function under a base-side eslint-disable header still FAILs`; `rules.test.ts :: trust boundary never loads the candidate eslint config and ignores inline disables` |
| 14.31 | Fifth parameter added on another line of an existing function → G2 FAIL (new-violation rule) | ✅ ↪ D21c | `lint/evaluate.ts` | `evaluate.test.ts :: new-violation rule FAILs when a fifth parameter is added on another line (reported at the function's first line)`; `test/lint/round2.test.ts :: ruling D21c: unmatched units credit vanished baseline hits …` |
| 14.32 | Branches hidden with logical assignment / combinators / boolean indexing (7.2 f, f′, f″) → G1 may PASS, **S9 → G6 required** | ✅ ↪ D8, D17, D20 | `lint/rules/branch-hiding.ts` (absolute S9), `cx` (`s9Triggers`, B-relative) | `manipulation.test.ts :: spec 7.2 variants through G1 f: G1 PASS; legacy S5+S9; new -`, `… f′: …`, `… f″: …`; `variants.test.ts :: spec 7.2 rewrites f: logical assignment control flow`, `… f′: boolean arithmetic`, `… f″: generic combinators`; `rules.test.ts :: branch hiding (S9 trigger, …) …`; `test/lint/round2.test.ts :: ruling D8: logical assignment …`, `ruling D17: new S9 selectors …` |
| 14.33 | Split into 11 ctx-mutating helpers (7.2 b), with and without Prettier → S1 and S10 → G6 required | ⚠️ ↪ D17 | `cx` (`s1Triggers`, `s10Triggers`), `lint/rules/param-mutation.ts` | `manipulation.test.ts :: spec 7.2 variants through G1 b: G1 PASS; legacy S1+S5+S10; new S10`, `… S1 evidence uses visible branches, not ΣCogC (b: V 16→16, ΣCogC 24→17)`; `evaluate.test.ts :: triggers S10 for ctx-mutating helpers (spec 7.2 b)`; `variants.test.ts :: spec 7.2 rewrites b: ctx-mutating helpers`. **Gap:** only the fixture's own formatting is run. No Prettier-formatted copy of (b) is tested. |
| 14.34 | Part of a >15 legacy unit hidden with `&&=` plus a new branch (V10) → S5 + S9 → G6 required | ⚠️ | `cx` (`s5Triggers`, `s9Triggers` line path, D20) | Closest tests: `manipulation.test.ts :: … f: G1 PASS; legacy S5+S9` (a whole-unit `&&=` rewrite of the 24/17 legacy unit) and `decision.test.ts :: triggers S9 (D20): a drop of 1 never fires; 2 fires on the line path only when lines are kept`. **Gap:** no test reproduces the exact V10 shape (24/17 → 24/16 with a new nested branch). |
| 14.35 | Same manipulation split over 3 PRs → moving baseline fires S1, S9, S10 | ⚠️ | `src/pipeline/moving-baseline.ts`, `src/pipeline/run.ts` | `test/e2e/moving-baseline.test.ts :: moving baseline (spec 7.5) a rewrite split over three PRs shows up against the moving baseline only`, `… chooses the older lookback candidate, never older than the file`. **Gap:** only S9 is asserted, not S1 or S10. With `triggers.moving_baseline.route=false` (the default) the hits are observe-only and G6 is not required. |
| 14.36 | New commit pushed to a triggered file after simplification-review approval → approval void, re-approval needed | ✅ ↪ D13, #8 | `src/review/simplification.ts` | `test/platform/review.test.ts :: G6 simplification review is invalidated by a new push touching triggered files`, `… carries over on a patch-id-equal rebase or a push that avoids triggered files`; `gates.test.ts :: G6 simplification review end to end helper-splitting manipulation routes to review; an independent approval clears it until a push touches the file`; `test/service/security.test.ts :: #8 approvals bind to an explicit sha= …` |
| 14.37 | INCONCLUSIVE reported as `neutral` → aggregator rejects (required check fails) | ✅ | `src/aggregate/schema.ts` (state enum), `src/report/checkrun.ts` | `aggregate.test.ts :: quality-gate aggregation validates artifact JSON` (`state: "neutral"` throws); `test/platform/report.test.ts :: check runs never emits neutral or skipped for any state`, `… INCONCLUSIVE is a failure titled with its reason` |
| 14.38 | A PR workflow posts a same-name successful check → ignored (source is not the gate App) | ✅ | `src/service/handlers.ts` (`ownCheckRuns`), `agg` (provenance) | `test/platform/service.test.ts :: pull_request pre-check ignores a same-name check posted by a PR workflow and creates its own`; `aggregate.test.ts :: … refuses service gates submitted from Actions` |

### 다른 게이트 (other gates)

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.39 | Split lowered the score but tests fail → not mergeable, whatever G1 says | ✅ | `tg/evaluate.ts`, `agg` | `test/tests-gate/evaluate.test.ts :: G4 tests gate FAILs when tests fail, even if the refactor lowered complexity` |
| 14.40 | Test deleted, `.only` added, coverage config weakened → G4 FAIL, not waivable | ✅ ↪ D1, D3, F12 | `tg/evaluate.ts`, `tg/static.ts`, `tg/config.ts`, `src/waivers/index.ts` (`NON_WAIVABLE_REASONS`), `src/waivers/test-approval.ts` | `evaluate.test.ts :: G4 tests gate FAILs a deleted test (report and static evidence), not waivable`, `… FAILs newly added .only/.skip/xit/fails but not pre-existing ones`, `… FAILs weakened coverage configuration for everyone`, `… D3: a proven rename … is observe; a changed body stays TEST_REMOVED`; `test/tests-gate/config.test.ts :: config weakening …`; `test/platform/round2.test.ts :: D14: waivability {"reason":"TEST_REMOVED"} → false`; gate-owner approval (F12): `round2.test.ts :: F12: gate-owner test approvals …` |
| 14.41 | Matcher weakened, snapshot updated → S7 → G6 required | ✅ | `tg/evaluate.ts` (`weakeningSignals`), `tg/report.ts` | `evaluate.test.ts :: G4 tests gate routes matcher weakening, assertion loss and snapshot updates to S7 for people`, `… routes .snap file updates to S7 but not newly added snapshot files`, `… FAILs a run that rewrote snapshots` |
| 14.42 | Merge target or candidate changed → previous result not reused | ✅ ↪ #5 | `agg` (B/C/P/M check), `src/service/handlers.ts` (`EvaluationQueue`, `checkExternalId`) | `aggregate.test.ts :: … rejects results with another B/C/P/M`; `service.test.ts :: pull_request pre-check does not judge a stale test merge or a missing one`, `merge_group official verdict refuses an evaluation computed for another B/C`; `security.test.ts :: #5/#6 service races an older evaluation finishing last never overwrites a newer verdict (same B/C/P)` |

### waiver

| # | Case → expected | Status | Implementation | Tests |
|---|---|---|---|---|
| 14.43 | Expired, target code changed, ceiling exceeded → waiver invalid | ✅ ↪ D15 | `src/waivers/index.ts` | `test/platform/waivers.test.ts :: waiver approval validity (spec 14) expires after max_days or the requested date`, `… is void when the code changed after approval`, `applying waivers does not cover a value above the ceiling`; carry-over (D15): `round2.test.ts :: D15: waiver carry-over to a new blob …` |
| 14.44 | Approval by the author, a commit participant, the agent invoker or a bot → rejected | ✅ ↪ #7 | `src/review/independence.ts`, `src/waivers/index.ts` | `waivers.test.ts :: waiver approval validity (spec 14) rejects an approver who is the PR author`, `… the commit author`, `… the committer`, `… the co-author via noreply trailer`, `… the agent invoker`, `… rejects bots even when listed as approvers`; `security.test.ts :: #7 independence when identities are unresolved …` |

## 2. SPEC §6.3 invocation contract and the nine checks

| # | Check (reason) | Status | Implementation | Tests |
|---|---|---|---|---|
| 6.3.1 | Binary sha256 = pin and `--version` = `cccc 1.8.5` (`MEASURER_MISMATCH`) | ⚠️ ↪ F10 | `src/measure/fingerprint.ts` (`checkMeasurer`) | sha256: `measure.test.ts :: measureSides end to end measurer pin mismatch stops before measuring`; `test/measure/round2.test.ts :: unpinned measurer (audit F10) …` (4 tests). **Gap:** the `--version` branch (`fingerprint.ts:62`) has no test. |
| 6.3.2 | `rc == 0` (`MEASURER_EXIT`) | ✅ | `src/measure/cccc.ts` | `validate.test.ts :: … MEASURER_EXIT on any non-zero exit (the runner never passes --max-*)` |
| 6.3.3 | Non-empty manifest ⇒ non-empty stdout (`EMPTY_OUTPUT`) | ✅ | `src/measure/cccc.ts` | `validate.test.ts :: … EMPTY_OUTPUT when the manifest is non-empty but stdout is empty` |
| 6.3.4 | JSON, `files`/`summary`, five unit fields (`SCHEMA`) | ✅ | `src/measure/cccc.ts` (zod schemas) | `validate.test.ts :: … SCHEMA on non-JSON or a changed shape` |
| 6.3.5 | `files[].path` set = manifest, `file_count` = manifest size (`MANIFEST_MISMATCH`) | ✅ | `src/measure/cccc.ts` | `validate.test.ts :: … MANIFEST_MISMATCH for a missing, an extra or a duplicated file, or a wrong file_count`, `… accepts the ./ prefix cccc echoes for ./-prefixed arguments` |
| 6.3.6 | stderr empty (`MEASURER_STDERR`) | ✅ | `src/measure/cccc.ts` | `validate.test.ts :: … MEASURER_STDERR for any stderr output` |
| 6.3.7 | No `parse_errors` on C (`PARSE_ERROR_CANDIDATE`) | ✅ ↪ F5 | `src/measure/cccc.ts` | `validate.test.ts :: … PARSE_ERROR_CANDIDATE for C-side parse errors, author-fixable`; `test/measure/round2.test.ts :: parser lag (audit F5) …` |
| 6.3.8 | Residue ≥ 0 for every file (`INVARIANT_VIOLATION`) | ✅ | `src/measure/cccc.ts` | `validate.test.ts :: … INVARIANT_VIOLATION when functions sum above the file total` |
| 6.3.9 | Run time < 120 s (`TIMEOUT`) | ✅ | `src/measure/cccc.ts` (`runOnce` SIGKILL, `validateCcccRun`) | `validate.test.ts :: … TIMEOUT when killed or over budget` |
| 6.3.a | Argv: `--no-config --no-cache --lang es -j N --` + manifest paths, no dirs, `--exclude`, `--min`, `--top-*`, `--max-*` or `--pretty` | ⚠️ | `src/measure/fingerprint.ts` (`ccccArgsTemplate`), `src/measure/cccc.ts` | Indirect only: the cccc.toml tests (14.26) prove `--no-config` works. No test asserts the argv or `args_template`. |
| 6.3.b | Empty env (`PATH=/usr/bin:/bin`, temp `HOME`) | ⚠️ | `src/measure/cccc.ts` (`runOnce`), `src/measure/fingerprint.ts` (`probeVersion`) | None directly. Verified by code reading and the security review ("token never in argv/env of git or cccc"). |
| 6.3.c | Chunks of 1,000 files, each validated, then merged | ⚠️ | `src/measure/cccc.ts` (`runCccc` with `measurer.chunk_size`=1000, `validateRuns`) | No test runs more than one chunk (e.g. with `chunk_size: 1`). |
| 6.3.d | B-side parse error is not INCONCLUSIVE; invalid UTF-8 on C is author-fixable | ✅ | `src/measure/cccc.ts` | `validate.test.ts :: … B-side parse errors only remove the baseline`; `measure.test.ts :: … non-UTF-8 candidate file is INCONCLUSIVE and author-fixable` |

## 3. SPEC §9.1 state rules

| # | Rule | Status | Implementation | Tests |
|---|---|---|---|---|
| 9.1.1 | PASS → exit 0, `success` | ✅ | `src/types.ts` (`EXIT_CODE`), `src/report/checkrun.ts` | `test/e2e/cli.test.ts :: nyorori CLI exits 0/1/2 for PASS/FAIL/INCONCLUSIVE and writes the run artifacts`; `report.test.ts :: check runs never emits neutral or skipped for any state` |
| 9.1.2 | NOT_APPLICABLE → 0, `success` titled "N/A", never `skipped`/`neutral` | ✅ | `src/report/checkrun.ts` | `report.test.ts :: check runs NOT_APPLICABLE is success titled N/A`; `gates.test.ts :: … a docs-only PR is NOT_APPLICABLE and merge-allowed …` (asserts title "N/A"). Exit 0 for N/A comes from the `EXIT_CODE` map and is not exercised through the CLI. |
| 9.1.3 | ACCEPTED_WITH_WAIVER → 0, `success`, waiver items in the title | ⚠️ | `agg` (`verdictHeadline`), `src/waivers/index.ts` | `aggregate.test.ts :: quality-gate aggregation waived violations give ACCEPTED_WITH_WAIVER and allow merge`; `gates.test.ts :: waivers end to end …`. **Gap:** the title is the fixed string `"PASS with waiver"` (`agg:370-371`) with no waiver items, and no test checks the title. |
| 9.1.4 | FAIL → 1, `failure` | ✅ | `src/types.ts`, `src/report/checkrun.ts` | `cli.test.ts :: … exits 0/1/2 …` |
| 9.1.5 | INCONCLUSIVE → 2, **`failure`** titled "INCONCLUSIVE: reason" | ✅ | `src/report/checkrun.ts` | `report.test.ts :: check runs INCONCLUSIVE is a failure titled with its reason`; `cli.test.ts :: … exits 0/1/2 …`, `… uses exit 64 for usage errors and 2 when the gate cannot run` |
| 9.1.6 | The required check runs even on docs-only PRs; a missing run is never a pass | ✅ | `agg` (`REPORT_MISSING`), `src/service/handlers.ts` | `aggregate.test.ts :: … a gate that did not report is never a pass`, `… all N/A gives N/A (docs-only PR still reports)`; `service.test.ts :: pull_request pre-check publishes failure when evaluation throws` |
| 9.1.7 | Known violation + measurement error → both reported, FAIL wins | ✅ | `agg`, `src/report/result.ts` | `aggregate.test.ts :: … FAIL outranks INCONCLUSIVE and fail reasons come first`; `report.test.ts :: gate state reports FAIL and INCONCLUSIVE together, reasons deduped`, `gate state orders FAIL > INCONCLUSIVE > …`; `gates.test.ts :: … a syntax error that swallows named legacy units also routes S11, and FAIL outranks INCONCLUSIVE` |
| 9.1.8 | Deletion-only change → NOT_APPLICABLE (after recording deletions) | ⚠️ | `src/pipeline/service-gates.ts` (`hasMeasuredCode` counts `measure.B`) | No test. A manual probe (deleting `src/b.ts` only) gave complexity/lint/deps = **PASS**, not N/A (both are `success`; the state differs from the spec). |
| 9.1.9 | Zero-function file → can PASS after measurement and residue checks | ⚠️ | `cx`, `src/measure/cccc.ts` | As 14.21: no test. A manual probe gave PASS. |

## 4. SPEC §10.2 bypass vectors

| V | Vector | Status | Implementation | Tests |
|---|---|---|---|---|
| V1 | PR edits CI workflow, gate scripts or the required-check name | ✅ ↪ D1 | `src/service/*` (judging runs in the service), `agg` (provenance pins workflow path + SHA), `tg/evaluate.ts` (`.github/**` → S11 for people, FAIL for the loop) | `aggregate.test.ts :: … accepts PR-executing gates only from the pinned workflow for the candidate`, `… refuses service gates submitted from Actions`; `service.test.ts :: … ignores a same-name check posted by a PR workflow and creates its own`; `evaluate.test.ts :: G4 tests gate makes weakening a FAIL for the AI fix loop, and protected paths too` |
| V2 | `pull_request` workflow forges the check with an App key held in Actions secrets | ⚠️ | Architectural: the key exists only in `src/cli.ts serve` and `src/service/github.ts`. `templates/workflows/gate-untrusted-tests.yml` has no secrets. | Consequences only: `aggregate.test.ts :: … refuses service gates submitted from Actions`; `test/service/github.test.ts :: service helpers mirrors exactly the requested commits without putting the token in argv or the remote config`. |
| V3 | `pull_request_target` + PR head checkout | ✅ | `templates/workflows/gate-untrusted-tests.yml` (not used), `agg` (event must match the evaluation) | `aggregate.test.ts :: … accepts PR-executing gates only from the pinned workflow for the candidate` (rejects `event: "pull_request_target"`); `security.test.ts :: defence in depth a failed run's artifacts can prove a failure but never a pass` |
| V4 | PR-supplied `cccc.toml` / `.cccc.toml` / `.ignore` / `.gitignore` | ⚠️ | As 14.26 | As 14.26. `.cccc.toml`, `.ignore` and `.gitignore` are untested. |
| V5 | Syntax error, JSX-in-`.js`, Flow, >1000-level nesting, UTF-16/Latin-1 → 0 or a dropped file, exit 0 | ⚠️ | `src/measure/cccc.ts`, `src/git/manifest.ts` (JSX suffix) | As 14.16–14.18, 14.23; `cccc-rules.test.ts :: cccc 1.8.5 I/O behaviour … routes a .js.jsx copy as JSX while the plain .js fails to parse`, `… exits 0 even with parse errors, and reports them only in parse_errors`. **Gap:** no Flow or deep-nesting case. |
| V6 | `.gitattributes` `working-tree-encoding`, `filter=lfs`, `export-ignore` | ✅ | `src/git/tree.ts`, `src/git/manifest.ts` (`isLfsPointer`) | As 14.27; `manifest.test.ts :: pure helpers isLfsPointer`, `… detects LFS pointers, oversize blobs and case collisions`, `… ignores repository-level attributes and configs …` (`export-ignore`); `measure.test.ts :: line maps on real repositories ignores -diff/binary attributes in the candidate tree` |
| V7 | Code moved to `.vue` / `.svelte` / `.astro` / `.mdx` | ✅ ↪ D5, #3 | `src/git/manifest.ts`, `cx` | As 14.28; `test/git/round3.test.ts :: script-capable markup (security review #3) …` |
| V8 | Code moved into excluded paths (`generated/`, `vendor/`, test dirs) | ⚠️ ↪ D19, F3 | `src/git/manifest.ts`, `cx` (S11 for new excluded files, F3), `deps/evaluate.ts` (`DEP_FORBIDDEN_EDGE`) | `decision.test.ts :: triggers S11: unmeasured entries, new files in excluded paths, sensitive paths`; `regressions.test.ts :: F3: production code under a test glob …`; `test/deps/round2.test.ts :: ruling D19: product code may not import tests or excluded paths …`; `acceptance.test.ts :: logic parked under test-support paths …`. **Gap:** "generated code proven by a CI regeneration diff" is not implemented. |
| V9 | Submodule update, type change, symlink | ✅ | `src/git/manifest.ts` (mode 120000/160000, T) | `manifest.test.ts :: buildManifest on real repositories marks symlinks, submodules and type changes unmeasured`; `measure.test.ts :: tree materialization materializeFullTree writes regular files only` |
| V10 | `&&=` hides part of a >15 unit to make room for a new branch | ⚠️ | `cx` (S5, S9 line path) | As 14.34 (no exact repro) |
| V11 | Rename / duplicate names / anonymous / overloads / same line / confusables launder identity | ✅ ↪ D21 | `src/units/match.ts`, `src/units/names.ts` | As 14.11–14.15 |
| V12 | Deliberately ambiguous code provokes INCONCLUSIVE; track INCONCLUSIVE rate per author/agent | ❌ | Ambiguity → FAIL is implemented (`UNMATCHED_OVER_BUDGET`, 14.13). No per-author/agent INCONCLUSIVE-rate tracking exists in `src/`. | Ambiguity part: as 14.13. Tracking: none. |
| V13 | AI edits other gates (test/coverage config, ignore comments, waiver ledger) | ✅ | `src/ailoop/index.ts`, `src/pipeline/decisions.ts` (`policyIntegrity`), `lint/run.ts` (`--no-inline-config`) | See §5; `rules.test.ts :: trust boundary never loads the candidate eslint config and ignores inline disables` |
| V14 | Waiver abuse (self-approval, invoker approval, accumulation, endless renewal) | ✅ ↪ D14, D15, F14 | `src/waivers/index.ts`, `src/review/independence.ts`, `src/service/ledger.ts` | As 14.43–14.44; `waivers.test.ts :: applying waivers enforces the per-PR budget`, `waiver parsing refuses requests from the AI fix loop`; `security.test.ts :: defence in depth ledger counts this quarter's waivers per repository; garbage counts as used`; `round2.test.ts :: F14: waivedBy is only trusted when the service applied it …` |
| V15 | Gradual manipulation across PRs | ⚠️ | `src/pipeline/moving-baseline.ts` | As 14.35 (observe-only by default) |
| V16 | Cache poisoning | ⚠️ | `src/measure/fingerprint.ts` (`--no-cache`) | No test asserts `--no-cache` (see 6.3.a). |
| V17 | `Object.constructor.constructor`, arrow `.constructor`, AsyncFunction, `Reflect.construct(Function,…)`, `import("data:…")` | ✅ ↪ F7 | `lint/rules/dynamic-code.ts` | `rules.test.ts :: dynamic code (block, spec 7.2 i / V17) …` (all variants incl. `data: import`, `AsyncFunction constructor`, `arrow .constructor`); `test/lint/round2.test.ts :: audit F7: dynamic-code gaps …` |
| V18 | Bidi control characters (Trojan Source) | ✅ | `lint/text.ts` (`scanBidi`), `lint/evaluate.ts` | `evaluate.test.ts :: suppressions and bidi FAILs on an added bidi control character`, `… does not fail bidi characters already on the base branch`; `test/lint/round2.test.ts :: audit bug #2: LF-based positions scanBidi counts LF lines only` |
| V19 | Size and time attacks | ✅ ↪ #2, #10 | `src/git/manifest.ts` (`max_file_bytes`), `src/measure/cccc.ts` (timeout), `src/service/zip.ts`, `src/service/http.ts` | `manifest.test.ts :: … detects LFS pointers, oversize blobs and case collisions`; `validate.test.ts :: … TIMEOUT when killed or over budget`; `test/git/round2.test.ts :: bounded blob reads (bug #10) …`; `security.test.ts :: #2 zip bombs and malformed archives …`; `test/platform/round2.test.ts :: bug #3: webhook server survives hostile clients …` |

## 5. SPEC §12.2 forbidden actions for the AI fix loop

| # | Forbidden item | Status | Implementation | Tests |
|---|---|---|---|---|
| 12.2.1 | Gate/tool config: `cccc.toml`, `.cccc.toml`, ESLint, dependency-cruiser, vitest, jest configs, `.gitignore`, `.ignore`, `.gitattributes`, CI workflow, waiver ledger | ✅ | `src/ailoop/index.ts` (`AI_LOOP_FORBIDDEN_PATHS` + `tests.protected_paths`), `tg/evaluate.ts` (`PROTECTED_PATH_MODIFIED`) | `test/platform/ailoop.test.ts :: AI loop forbidden changes (spec 12.2) flags gate and tool configuration paths`; `evaluate.test.ts :: G4 tests gate makes weakening a FAIL for the AI fix loop, and protected paths too` |
| 12.2.2 | `strict*` in `tsconfig*.json` | ✅ | `tg/config.ts`, `src/ailoop/index.ts` (`tsconfig*.json`) | `config.test.ts :: config weakening detects tsconfig strictness weakening with comments and trailing commas`; `ailoop.test.ts :: … flags gate and tool configuration paths` |
| 12.2.3 | `package.json` `scripts.test` and test-run flags | ✅ | `src/ailoop/index.ts` (`testConfigOf`), `tg/config.ts` | `ailoop.test.ts :: … flags test script changes in package.json but not dependency bumps`; `config.test.ts :: config weakening detects weakened package.json test scripts` |
| 12.2.4 | Deleting a test ID that existed in B | ✅ ↪ D3 | `tg/evaluate.ts` | `evaluate.test.ts :: G4 tests gate FAILs a deleted test (report and static evidence), not waivable`; D3 rename (loop: FAIL): `… D3: a proven rename …` |
| 12.2.5 | `.only` / `.skip` / `xit` / `todo` | ✅ ↪ D2 | `tg/evaluate.ts`, `tg/static.ts` | `evaluate.test.ts :: … FAILs newly added .only/.skip/xit/fails but not pre-existing ones`, `… D2/D14: a new assertion-free test is S7 and a new todo is observe for people; both FAIL for the AI loop`, `… D2: todo on an existing test FAILs; a new skipIf/runIf is S7` |
| 12.2.6 | Fewer assertions, weaker matchers | ✅ | `tg/evaluate.ts` (`weakeningSignals`) | `evaluate.test.ts :: … makes weakening a FAIL for the AI fix loop, and protected paths too` (matcher); `… routes matcher weakening, assertion loss and snapshot updates to S7 for people` (assertion loss is FAIL for the loop by the same branch; that branch is asserted for the matcher case only) |
| 12.2.7 | Snapshot update (`-u`) | ✅ | `tg/report.ts`, `tg/evaluate.ts`, `src/ailoop/index.ts` (`*.snap`, `__snapshots__`) | `evaluate.test.ts :: G4 tests gate FAILs a run that rewrote snapshots`; `test/tests-gate/report.test.ts :: vitest 4.1 JSON report flags snapshot rewriting`; `ailoop.test.ts :: … flags gate and tool configuration paths` (`src/__snapshots__/a.snap`) |
| 12.2.8 | Added `eslint-disable*`, `istanbul`/`v8 ignore`, `@ts-ignore`, `@ts-nocheck` (except the P allowlist) | ✅ ↪ D9 | `lint/evaluate.ts` (`suppressionVerdict`), `lint/text.ts`, `src/ailoop/index.ts` (`SUPPRESSION_PATTERNS`) | `test/lint/round2.test.ts :: rulings D9 + D14: suppression scope // @ts-expect-error fails non-waivably for the AI loop`, `… // eslint-disable-next-line no-console fails non-waivably for the AI loop`, `… // @ts-ignore fails non-waivably for the AI loop`; `ailoop.test.ts :: … flags added suppression directives unless allowlisted`; `evaluate.test.ts :: suppressions and bidi honours the policy allowlist` |
| 12.2.9 | Moves out of measurement: `.ts` → unmeasured extension, code into excluded or generated paths | ✅ | `src/ailoop/index.ts` | `ailoop.test.ts :: AI loop forbidden changes (spec 12.2) flags moves out of measured extensions and into excluded paths` |
| 12.2.10 | Result is `FAIL(POLICY_PATH_MODIFIED)` / G4 FAIL; the loop cannot request a waiver | ✅ | `src/pipeline/decisions.ts` (`policyIntegrity`, bot identity from `ai_loop.bot_accounts`), `agg` (policy-integrity row), `src/waivers/index.ts` | `aggregate.test.ts :: quality-gate aggregation policy-integrity findings block`; `waivers.test.ts :: waiver parsing refuses requests from the AI fix loop` |

## Summary

| Section | ✅ | ⚠️ | ❌ |
|---|---|---|---|
| §14 (44 rows) | 36 | 7 | 1 |
| §6.3 (13 rows) | 9 | 4 | 0 |
| §9.1 (9 rules) | 6 | 3 | 0 |
| §10.2 (19 vectors) | 11 | 7 | 1 |
| §12.2 (10 items) | 10 | 0 | 0 |

## Post-review updates (release cleanup)

Rows that the review marked ⚠️/❌ and that the release-cleanup round closed:

| Row | Was | Now | Evidence |
|---|---|---|---|
| 14.34 / V10 | ⚠️ no exact-shape test | ✅ | `test/e2e/release.test.ts` V10 case (S5 + S9 routed, merge blocked) |
| 14.35 / V15 | ⚠️ S9 only, observe only | ✅ | `release.test.ts` three-PR helper split: moving baseline fires S1 and S10; `route: true` → REVIEW_REQUIRED |
| 14.16 / V5 | ⚠️ no >1000-level nesting test | ✅ (Flow still untested) | `release.test.ts` 1,100-level literal → INCONCLUSIVE PARSE_ERROR_CANDIDATE |
| 6.3.1 | ⚠️ `--version` branch untested | ✅ | `test/measure/contract.test.ts` version mismatch with matching sha256 |
| 6.3.a/b/c, V16 | ⚠️ argv/env/chunking unasserted | ✅ | `contract.test.ts` argv, env, chunking, per-chunk validation |
| 9.1.8 | ⚠️ deletion-only gave PASS (bug) | ✅ fixed | `src/pipeline/scope.ts`; `release.test.ts` deletion-only → N/A |
| 9.1.3 | ⚠️ waiver title without items | ✅ fixed | `verdictHeadline` in `src/aggregate/index.ts`; e2e waiver test asserts the title |
| 14.26 / V4 | ⚠️ only `cccc.toml` tested | ✅ | `release.test.ts` `.cccc.toml`, `.ignore`, `.gitignore` |
| 14.33 | ⚠️ (b) not Prettier-reformatted | ✅ | `release.test.ts` reformatted variant (b) still fires S1/S10 |
| 14.1 | ❌ no repeat-run test | ✅ | `release.test.ts` identical results on two runs |
| 14.20 / 14.21 / 9.1.9 | ⚠️ | ✅ | `release.test.ts` docs-only N/A with reason, zero-function `.ts` PASS |

Still open (documented gaps, not blocking v1):

- **V8:** "generated code is proven by CI regeneration" is not implemented. Exclusions come from P only, and new files under excluded paths route S11.
- **V12:** per-author/agent INCONCLUSIVE-rate tracking is a P1 operations metric, not yet built.
- **V2:** architectural only; the key lives only in the service.
- **Flow syntax fixture:** not added.

## Round 4 (two-branch comparative review) closures

| Spec / ruling | Was | Now | Evidence |
|---|---|---|---|
| 5.4 allowance is a privilege; 2.3 scope | test→product move with identical bytes inherited the test unit's allowance (false PASS) | ✅ scope-aware matching refuses cross-scope pairs → UNMATCHED_OVER_BUDGET + S11 | `test/complexity/round4.test.ts`, `test/e2e/round4.test.ts` scope-move row |
| 5.4 step 3 (anonymous excluded) | round-2 D21b let anonymous units into k-to-k (false PASS, differential m16b) | ✅ reversed | `test/complexity/round4.test.ts` m16/m16b ports |
| 10.2 V17 | `.constructor` value escaping (`const F = g.constructor; F(…)`, `.call/.apply`, `Reflect.apply`, array index) not blocked | ✅ DYNAMIC_CODE when the value escapes; `.name`/comparison reads stay clean; 0 FP on 1,722 files | `test/lint/round2.test.ts` escape cases; e2e round4 |
| 6.4 unit vanish | named B unit vanished while the name stayed bound via another class → no S11 | ✅ | `test/complexity/round4.test.ts` m15b |
| 7.5 S5 residue | residue edits between units with unchanged score fired no S5 | ✅ closing-brace gaps | `test/complexity/round4.test.ts` residue rows |
| 9.1 / 14 zero-function `.d.ts` | not measured → N/A | ✅ measured PASS; implementation inside → author-fixable PARSE_ERROR_CANDIDATE | `test/git/manifest.test.ts`, `test/measure/round4.test.ts`, e2e round4 |
| 6.1 measurer pin (TOCTOU) | hashed path re-spawned later | ✅ private 0o500 copy of the hashed bytes is what runs | `test/measure/round4.test.ts` swap-after-hash |
| 6.4 determinism | 5% sample, one chunk | ✅ official runs re-run every C chunk with `-j1` (`determinism_sample_rate_official` 1.0) | `test/measure/round4.test.ts` |
| 6.1 installer | silent source-build fallback | ✅ fail-closed: pinned archive+binary sha256 (verified against the real v1.8.5 asset), `.sha256` cross-check, attestation + verify-asset, single member | `scripts/fetch-cccc.sh`, dry-run with stub `gh` |
| 6.1 upgrade check (200 PR 재생), 13.3 friction, 13.4 recovery | only `fixtures` | ✅ `nyorori replay` (pairs dataset, policy/binary comparison, deltas, friction totals, exit 0/1/2) | `test/replay/*.test.ts` |
| 10.1 App key isolation | analysis in the key-holding process | ✅ detached worker (env scrub, 1 GiB heap, 300 s wall, pgroup kill, 64 MiB output cap); crash → TOOL_ERROR, never a missing check; zips inflated in the worker | `test/pipeline/isolated.test.ts`, `test/e2e/worker.test.ts` |
| 10.1 / 2.3 policy outside the candidate | README read the policy from the checkout | ✅ realpath refusal of policy/cccc/out/artifacts inside `--repo` (exit 64; `--allow-repo-paths` for fixtures); `authority: local | github-app` | `test/pipeline/paths` rows, e2e cli |
| 7.6 / 11.1 agent-invoker independence | `agentInvokers: []` hard-coded | ✅ assignees, @mentions, linked-issue authors; AI-loop PR with unknown invokers needs two approvers | `test/service/round4.test.ts`, `test/platform/*` |
| 10.1 evidence provenance | run matched via `referenced_workflows` only; artifact not bound to the attempt | ✅ `run.path` must equal the trusted path; artifact `created_at ≥ run_started_at` and head bound; scoped installation tokens | `test/service/round4.test.ts` |
| 13.1 모든 가상 판정 기록 | no shadow verdict | ✅ `would_block` + `shadow` in verdict, check title, summary, feedback | `test/platform/aggregate*.test.ts` |
| 12.3 same B; INCONCLUSIVE hand-off | `decideRetry` ignored INCONCLUSIVE and B/P/M drift | ✅ | `test/platform/ailoop.test.ts` |
| 11.1 waiver flow usable end to end | pending requests left no trace | ✅ `pending_waivers` with copyable approve command | e2e supplement row |
| D14 waivable on-base failure | G4 unit keys had no path → unwaivable in production | ✅ `${file}::${name}` | `/tmp/freshreview/r1` port in `test/tests-gate` |
| 8.3 moved test file | rename out of test globs → un-overridable INCONCLUSIVE | ✅ TEST_REMOVED | `test/tests-gate` r3 port |
| 11.2 transient retry | missing test merge published as failure at once | ✅ 5× backoff polling while in_progress | `test/service/round4.test.ts` |
| 7.5 moving baseline cost | O(files × history), 61.5 s on 5k×300 | ✅ one `git log` pass, 215 ms; `max_files` 200 skip when observe-only | `test/pipeline/history.test.ts` |
| 13.4 durability | in-memory queue/dedupe | ✅ job journal replayed on restart; persisted delivery dedupe; `/healthz` | `test/service/round4.test.ts` |
