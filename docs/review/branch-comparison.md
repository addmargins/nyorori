# Two-branch comparative review

Compared: `claude/great-johnson-jzhmli` (ours, HEAD 040125f) and `feat/production-quality-gate`
(451eb5a, an independent implementation of the same spec; builds and passes 235 tests on Node 22).
Reviewers: trust architecture, G1–G3, G4–G7/ops, differential tester, fresh correctness review.
Rulings in `## Rulings`; the other branch's defects are listed for its author in `## Findings for feat/production-quality-gate`.

## Trust architecture

| Axis | Stronger | Adopt into ours |
|---|---|---|
| App-key process isolation | theirs (detached worker, heap/wall caps, durable job journal) | yes: fork `runGates` into a child with env scrub, heap cap, wall timeout, process-group kill; job journal replayed on restart |
| Agent-invoker independence | neither implemented in service; ours hard-codes `agentInvokers: []` | yes: fill from PR assignees/invoker; AI-loop PR with unknown invokers requires two approvers |
| Policy/measurer/out outside the target repo | theirs enforces | yes: refuse realpaths inside `repoDir` (CLI `--allow-repo-paths` escape for fixtures); `authority: local|github-app` marker |
| Measurer TOCTOU / determinism | theirs (private 0o500 copy; full `-j1` rerun) | yes: execute a private copy of the hashed bytes; `-j1` rerun rate 1.0 for `merge_group` |
| Evidence binding | theirs stronger binding, ours stronger automation | partial: require `run.path === wf.path`; bind artifacts to the attempt (`created_at >= run_started_at`); scope installation tokens |
| Shadow semantics | equal; theirs has `would_block` | yes: `would_block` in verdict and summary |
| Approval authority | ours (live rosters, commit/co-author independence, sha/blob binding, edited-comment rejection) | keep |

## G1–G3

False-PASS defects in ours (fix): test→product move with identical bytes inherits the test unit's allowance;
`.constructor` value escape (`const F = g.constructor; F(...)`, `.call/.apply`, `Reflect.apply`, array indexing)
not blocked; product→test rename named `*.test.*` does not route S11; `jsconfig.json`/`tsconfig.*.json`
aliases ignored by G3; residue S5 misses edits between units when the score is unchanged.
Not adopted from theirs (contradict rulings D5–D11, D17, D20, D21): per-edge cycle FAIL incl. type-only and lazy
edges, G3 INCONCLUSIVE by presence of bundler/tsconfig features or any unknown extension in the whole tree,
`max-params` in tests, non-waivable `@ts-ignore`, `x.constructor.name` FAIL, dispatch-table S9 on any object
with one arrow property, memo idioms as S9, no k-to-k / normalized-identical matching.

## G4–G7 and operations

Ours stronger: G4 (real Jest/Vitest JSON + AST integrity + rename rule), G7 (survivors on changed lines),
AI-loop mechanical 12.2 checks, comment commands, incident runbook with `degraded`, traceability.
Adopt from theirs: `nyorori replay` (spec 6.1/13.4), fail-closed installer, `would_block`, demo script,
deployment doc sections (OS isolation, secrets, retention, health, validation boundary), `decideRetry`
hand-off on INCONCLUSIVE and B/P/M drift, pinned `coverage.provider_version`.

## Differential testing (89 scenarios, both CLIs on the same repos)

Both implementations are deterministic. Agreement on all spec-14 policy rows, bypass rows and most
manipulation variants. Disagreements and verdicts:

| Scenario | Ours | Theirs | Right |
|---|---|---|---|
| Two anonymous units on one line swapped / new anonymous 18 next to legacy 18 | PASS via k-to-k (ruling D21b included anonymous) | UNMATCHED_OVER_BUDGET | **theirs** — spec 5.4 step 3 excludes anonymous; D21b narrowed to named units |
| New zero-function `.d.ts` | N/A (not measured) | G6 FAIL (S11 DECLARATION_ONLY) | both wrong; spec: measured, PASS |
| Vanished named B unit still bound in C (`run` across classes) | no S11 | S11 | theirs (spec 6.4) |
| New CogC-15 function that reassigns its own parameter | PASS | G6 FAIL (S10 on any param reassignment) | ours |
| B-side syntax error | FAIL/PASS by C | G3 INCONCLUSIVE | ours (spec 6.3) |
| Non-UTF-8 file | INCONCLUSIVE author-fixable | S11 → aggregate FAIL | ours (spec 11.2) |
| Unrelated PR whose 5-commits-back tree has a Latin-1 file | PASS | INCONCLUSIVE ROLLING_BASELINE_INCOMPLETE | ours (rolling comparison must never change G1 state) |
| Deletion-only PR | N/A | PASS | ours (spec 9.1) |
| Cyrillic-е rename | FAIL + mixed-script warning | FAIL, no warning | ours |
| `.ts` → symlink with body in vendor/ | stage-4 move PASS + S11 | OVER_LIMIT_NEW + S11 | both block |
| Variant (c) as new code | S9 only (S10 needs V ≥ 8, ruling D17) | S9 + S10 | deliberate deviation, kept |
| Variant (f) as new code | S4 also fires via `max-statements` 38 > 30 (ruling D12) | S9 only | deliberate deviation, kept; calibrate in shadow |
| 2,000-file PR | 52 s | 127 s | — |

## Fresh correctness review of our branch (code after 2d4d452, at 040125f)

No false PASS found; the service flow was verified end to end (real git + cccc + pipeline behind
`dispatchEvent` with a fake GitHub API: FAIL published, waiver request → approval → ACCEPTED_WITH_WAIVER,
edited review ignored, concurrent events publish once, merge → ledger + one debt issue, redelivery idempotent).
Defects (all assigned): G4 violation unit keys carry no path so ruling D14's waivable on-base failures could
never be waived (the test fabricated the key); pending waiver requests never surface their id/blob; a test file
renamed out of the test globs becomes an un-overridable INCONCLUSIVE instead of TEST_REMOVED; no retry when
GitHub's test merge is not ready yet; moving baseline is O(files × history) and sequential; a provenance
problem discards a service-computed FAIL; verdict stored before publication; IssuedDebtStore unlocked;
a generation race in runAndPublish.

## Rulings (round 4)

Adopt from `feat/production-quality-gate`: worker-process isolation with a job journal; private copy of the
hashed measurer and a full `-j1` rerun for official runs; refusal of policy/binary/out paths inside the
target repo and an `authority` marker; `run.path` binding and attempt-bound artifacts; scoped tokens;
`would_block`; `nyorori replay`; fail-closed installer; demo script; deployment-doc sections; retry hand-off on
INCONCLUSIVE and B/P/M drift; scope-classification-aware unit matching; blanket `.constructor` value-escape
rule (keeping the `.name` exemption); `jsconfig.json` aliases; measured `.d.ts`.
Reversed: round-2 "k-to-k includes anonymous units" (differential test m16b).
Kept against the other implementation: D7 SCC-partition cycles, D9/D10/D11 suppression and import rulings,
D17/D20 trigger thresholds, D21a/b named matching, per-file moving baseline, content-sniffed markup,
dependency-cruiser resolver with S3/S11 routing instead of INCONCLUSIVE-by-presence.

## Findings for feat/production-quality-gate (not changed here; for its author)

- S10 fires on any new function that reassigns its own parameter → a spec-PASS PR needs G6 (9 of 89 scenarios).
- Rolling baseline turns an unrelated PR INCONCLUSIVE when a historical tree has a measurement issue; a routing input must never change G1 state.
- B-side syntax error makes G3 INCONCLUSIVE (spec 6.3 says B parse errors are never INCONCLUSIVE).
- A new declaration-only `.d.ts` blocks the merge via S11; a non-UTF-8 file becomes a review FAIL instead of an author-fixable INCONCLUSIVE; deletion-only PR aggregates PASS instead of N/A.
- No confusable-identifier warning on a Cyrillic-е rename; computed-constructor folding is one level deep (`"constr"+"uctor"` via a const passes).
- G4: `it.each` / template titles make the whole PR INCONCLUSIVE; test IDs are bare titles so deleting one of two same-titled tests is PASS; new `todo` FAILs. G5: Istanbul implicit-else locations throw; every changed function including anonymous callbacks is a hard FAIL. G7: no survivor list.
- G3 INCONCLUSIVE by presence of any bundler/tsconfig feature or any unknown extension anywhere in the tree; per-edge cycle FAIL including type-only and lazy edges; `max-params` and non-waivable suppressions in test files; `x.constructor.name` FAIL; dispatch-table S9 on any object with one arrow property.
- No approval ingestion (authority file trusted verbatim), `merge_group` only (no pre-check), AI-loop rules keyed on an evidence actor that defaults to unknown, no measurement override, no `degraded` mode, attestation manual and voided by any service upgrade.

## Re-verification after round 4

Clean clone of 97fdd27: typecheck, lint, 976 tests in 60 files, build, 39 rule fixtures with 0 drift,
regenerated policy identical. The 89-scenario differential harness re-run on the rebuilt CLI changed only
the rows the rulings targeted — zero-function `.d.ts` N/A → measured PASS; the two anonymous-unit
rows PASS → `UNMATCHED_OVER_BUDGET`; the vanished-unit row now routes S11 — and every other row is
identical to the previous run.
