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
