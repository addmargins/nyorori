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
